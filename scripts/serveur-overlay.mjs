#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Serveur d'overlay : sert un site local et y injecte l'overlay d'édition.

   Deux modes :
     --dossier <chemin>     site statique : sert les fichiers du dossier
     --proxy <url>          framework : relaie vers le serveur de dev du projet
                            (Next, Vite, Astro…), WebSockets compris pour le
                            rechargement à chaud

   Dans les deux cas, chaque réponse HTML reçoit `<script src="/__overlay/overlay.js">`
   juste avant </body>. Les commentaires postés par l'overlay arrivent sur
   POST /__overlay/comments et sont écrits dans <racine>/.overlay/comments.json,
   les images jointes dans <racine>/.overlay/attachments/.

   Options :
     --racine <chemin>      où écrire .overlay/ (défaut : le dossier servi, ou cwd)
     --port <n>             port de départ (défaut 4400 ; se décale s'il est pris)
     --sans-overlay         n'injecter que la synchronisation des téléphones. Automatique
                            sur un projet /buildyoursite, qui porte déjà son propre overlay

   Chaque page reçoit aussi `synchro.js`, qui relie la fenêtre principale aux
   téléphones flottants (scripts/telephones.mjs) : la fenêtre publie sa page,
   son défilement, l'état de son navigateur (cookies, localStorage) et ses
   gestes (clics, saisies, touches) sur POST /__overlay/synchro, les téléphones
   les reçoivent en flux continu sur GET /__overlay/synchro. En mode proxy, un
   envoi de formulaire rejoué par un téléphone reçoit la réponse de la fenêtre
   principale au lieu d'atteindre le site une seconde fois.

   Affiche `OVERLAY_URL=http://localhost:<port>` une fois prêt. C'est cette
   ligne qu'il faut lire, jamais supposer le port.

   Pourquoi un serveur à part plutôt qu'un composant dans le site : pour ne pas
   avoir à toucher au code d'un site qu'on ne fait qu'éditer. Le site ne sait
   pas qu'il est observé.
--------------------------------------------------------------------------- */

import http from "node:http";
import https from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf("--" + n);
  return i >= 0 ? args[i + 1] : d;
};

const dossier = opt("dossier") ? path.resolve(opt("dossier")) : null;
const cible = opt("proxy");

if (!dossier && !cible) {
  console.error(
    "Usage :\n" +
      "  node serveur-overlay.mjs --dossier <site statique> [--racine <chemin>] [--port 4400]\n" +
      "  node serveur-overlay.mjs --proxy http://localhost:3000 --racine <projet> [--port 4400]",
  );
  process.exit(1);
}
if (dossier && !existsSync(dossier)) {
  console.error("Dossier introuvable : " + dossier);
  process.exit(1);
}

const racine = path.resolve(opt("racine") ?? dossier ?? process.cwd());
let port = Number(opt("port", 4400));

const DOSSIER_OVERLAY = path.join(racine, ".overlay");
const FICHIER_COMMENTAIRES = path.join(DOSSIER_OVERLAY, "comments.json");
const DOSSIER_PIECES = path.join(DOSSIER_OVERLAY, "attachments");
const SCRIPT_OVERLAY = path.join(ICI, "overlay.js");
const SCRIPT_SYNCHRO = path.join(ICI, "synchro.js");
const SCRIPT_DEPLACER = path.join(ICI, "deplacer.js");

/* Un projet /buildyoursite rend son propre overlay, en React, après
   l'hydratation : notre script, qui vérifie sa présence à son chargement,
   arriverait avant lui et en monterait un second. On le reconnaît donc au
   disque, et on n'injecte que la synchronisation. */
const projetBuildyoursite = existsSync(path.join(racine, "components", "buildyoursite", "overlay.tsx"));
const sansOverlay = args.includes("--sans-overlay") || projetBuildyoursite;

// La synchronisation passe en premier : dans un téléphone, elle lève le drapeau
// qui empêche overlay.js de se monter.
// Le module « déplacer à la souris » vient dans tous les cas, y compris pour un
// projet /buildyoursite : il lit le mode Édition sur les boutons de l'overlay,
// quel qu'il soit, et reste inerte tant qu'aucun overlay n'est monté (dans un
// téléphone, par exemple).
const BALISE =
  '<script src="/__overlay/synchro.js" defer></script>' +
  (sansOverlay ? "" : '<script src="/__overlay/overlay.js" defer></script>') +
  '<script src="/__overlay/deplacer.js" defer></script>';

/* ------------------------------ téléphones ------------------------------- */

// Les téléphones se reconnaissent à leur agent utilisateur, suivi de leur nom :
// « … OverlayTelephone/1 standard ».
const estTelephone = (req) => /OverlayTelephone\//.test(req.headers["user-agent"] || "");
const idTelephone = (req) => ((req.headers["user-agent"] || "").match(/OverlayTelephone\/\S+\s+(\S+)/) || [])[1] || "telephone";

/* --------------------------------- hasard -------------------------------- */

/* Le hasard de la page, partagé entre la fenêtre principale et les téléphones :
   un avis tiré au sort, un ordre mélangé, un logo qui se brouille. Sans ça,
   chaque fenêtre tirait le sien. Chaque page reçoit, avant tout autre script,
   un Math.random à graine. La fenêtre principale tire une graine neuve à chaque
   chargement de page, les téléphones reçoivent la sienne. Le tirage repart
   aussi de l'adresse : après une navigation sans rechargement, les fenêtres
   restent alignées (synchro.js appelle `__overlayHasard`). Le hasard calculé
   par le serveur du site, lui, ne se partage pas. */
let graineHasard = crypto.randomInt(1, 2 ** 31);

function grainePour(req) {
  // Seul un vrai chargement de page de la fenêtre principale renouvelle la graine.
  if (req && !estTelephone(req) && (req.headers["sec-fetch-dest"] || "document") === "document") {
    graineHasard = crypto.randomInt(1, 2 ** 31);
  }
  return graineHasard;
}

/* Le script s'efface dès qu'il a tourné. Resté en tête de page, il prenait la
   place du premier script du site quand React vérifie la page au démarrage
   (l'hydratation) : « A tree hydrated but some attributes didn't match ».
   Constaté le 2026-10-01 sur un site Next. */
const scriptHasard = (graine) =>
  "<script>(()=>{const b=" + graine + ";let s=0;" +
  "const g=(p)=>{let h=(2166136261^b)>>>0;for(let i=0;i<p.length;i++)h=Math.imul(h^p.charCodeAt(i),16777619)>>>0;s=h};" +
  "g(location.pathname+location.search);" +
  "Math.random=()=>{s=(s+0x6D2B79F5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);" +
  "return((t^(t>>>14))>>>0)/4294967296};window.__overlayHasard=g;" +
  "document.currentScript&&document.currentScript.remove()})()</script>";

/* ------------------------------ injection -------------------------------- */

/**
 * Pose le script juste avant </body>. À défaut, avant </html>, à défaut à la fin.
 * Et le hasard partagé tout en haut, juste après <head> : il doit précéder les
 * scripts du site. Jamais avant le doctype, qui ferait passer la page en mode
 * de compatibilité.
 *
 * Une politique de sécurité (CSP) déclarée dans une balise <meta> bloquerait le
 * script injecté : on la retire. Uniquement ici, en local, pour l'édition. Ce
 * n'est pas une modification du site, seulement de ce que le panneau en voit.
 */
function injecter(html, req = null) {
  let h = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, "");
  const hasard = scriptHasard(grainePour(req));
  if (/<head(\s[^>]*)?>/i.test(h)) h = h.replace(/<head(\s[^>]*)?>/i, (m) => m + hasard);
  else if (/<html(\s[^>]*)?>/i.test(h)) h = h.replace(/<html(\s[^>]*)?>/i, (m) => m + hasard);
  else if (/<!doctype[^>]*>/i.test(h)) h = h.replace(/<!doctype[^>]*>/i, (m) => m + hasard);
  else h = hasard + h;
  if (/<\/body>/i.test(h)) return h.replace(/<\/body>/i, BALISE + "</body>");
  if (/<\/html>/i.test(h)) return h.replace(/<\/html>/i, BALISE + "</html>");
  return h + BALISE;
}

function estHtml(type) {
  return typeof type === "string" && /text\/html/i.test(type);
}

/* ------------------------------ statique --------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * URL → fichier du dossier, ou null.
 * `/` → index.html ; `/tarifs` → tarifs.html, puis tarifs/index.html.
 * Toute tentative de sortir du dossier (`..`) est refusée.
 */
function resoudreFichier(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const absolu = path.resolve(dossier, "." + p);
  if (absolu !== dossier && !absolu.startsWith(dossier + path.sep)) return null;

  const candidats = [absolu];
  if (!path.extname(absolu)) candidats.push(absolu + ".html", path.join(absolu, "index.html"));

  for (const c of candidats) {
    try {
      const s = statSync(c);
      if (s.isFile()) return c;
      if (s.isDirectory()) {
        const index = path.join(c, "index.html");
        if (existsSync(index) && statSync(index).isFile()) return index;
      }
    } catch {
      /* suivant */
    }
  }
  return null;
}

async function servirStatique(req, res) {
  const fichier = resoudreFichier(req.url);
  if (!fichier) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(injecter("<!doctype html><title>404</title><h1>Introuvable</h1><p>" + req.url + "</p>", req));
    return;
  }
  const ext = path.extname(fichier).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";

  if (ext === ".html" || ext === ".htm") {
    const html = await readFile(fichier, "utf8");
    const corps = Buffer.from(injecter(html, req), "utf8");
    res.writeHead(200, { "content-type": type, "content-length": corps.length, "cache-control": "no-store" });
    res.end(corps);
    return;
  }

  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  createReadStream(fichier).pipe(res);
}

/* -------------------------------- proxy ---------------------------------- */

const amont = cible ? new URL(cible) : null;
const moduleAmont = amont?.protocol === "https:" ? https : http;

function optionsAmont(req) {
  return {
    hostname: amont.hostname,
    port: amont.port || (amont.protocol === "https:" ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: amont.host,
      // Sans ça, l'amont peut compresser, et on injecterait dans du gzip.
      "accept-encoding": "identity",
    },
  };
}

/* --------------------------- actions partagées --------------------------- */

/* Un clic rejoué sur « Envoyer » ferait partir le formulaire trois fois, une
   fois par fenêtre : trois demandes enregistrées, trois courriels. Seul l'envoi
   de la fenêtre principale atteint donc le site. Celui d'un téléphone, s'il
   arrive dans les quinze secondes pour la même adresse, reçoit la même
   réponse, recopiée : même écran de confirmation, une seule demande. Un envoi
   fait directement dans un téléphone, sans équivalent à gauche, passe. */
const DUREE_ACTION = 15000;
const ACTIONS = [];
const modifie = (req) => !["GET", "HEAD", "OPTIONS"].includes(req.method);
// Next range ses actions serveur sous l'adresse de la page : l'identifiant de
// l'action les distingue.
const cleAction = (req) => req.method + " " + req.url + " " + (req.headers["next-action"] || "");

function nouvelleAction(req) {
  const maintenant = Date.now();
  while (ACTIONS.length && maintenant - ACTIONS[0].date > DUREE_ACTION) ACTIONS.shift();
  const action = { cle: cleAction(req), date: maintenant, servis: new Set() };
  action.reponse = new Promise((ok) => (action.finir = ok));
  ACTIONS.push(action);
  return action;
}

function actionPour(req) {
  const cle = cleAction(req);
  const id = idTelephone(req);
  const maintenant = Date.now();
  return ACTIONS.find((a) => a.cle === cle && !a.servis.has(id) && maintenant - a.date < DUREE_ACTION) || null;
}

async function servirAction(action, req, res) {
  action.servis.add(idTelephone(req));
  req.resume(); // le corps envoyé par le téléphone ne sert à rien : on le laisse filer
  const r = await Promise.race([action.reponse, new Promise((ok) => setTimeout(() => ok(null), DUREE_ACTION))]);
  if (!r) {
    res.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
    return res.end("La fenêtre principale n'a pas reçu de réponse à recopier.");
  }
  const entetes = { ...r.entetes, "content-length": String(r.corps.length) };
  delete entetes["transfer-encoding"];
  res.writeHead(r.statut, entetes);
  res.end(r.corps);
}

function relayer(req, res) {
  if (modifie(req) && estTelephone(req)) {
    const deja = actionPour(req);
    if (deja) return servirAction(deja, req, res);
  }
  // Une action de la fenêtre principale garde sa réponse pour les téléphones.
  const action = modifie(req) && !estTelephone(req) ? nouvelleAction(req) : null;

  const requete = moduleAmont.request(optionsAmont(req), (reponse) => {
    const entetes = { ...reponse.headers };
    delete entetes["content-security-policy"];
    delete entetes["content-security-policy-report-only"];
    const statut = reponse.statusCode || 200;

    // On n'injecte que dans du HTML non compressé. Si l'amont a compressé malgré
    // la demande, on laisse passer tel quel plutôt que de corrompre la réponse.
    if (estHtml(entetes["content-type"]) && !entetes["content-encoding"]) {
      const morceaux = [];
      reponse.on("data", (d) => morceaux.push(d));
      reponse.on("end", () => {
        const corps = Buffer.from(injecter(Buffer.concat(morceaux).toString("utf8"), req), "utf8");
        entetes["content-length"] = String(corps.length);
        delete entetes["transfer-encoding"];
        if (action) action.finir({ statut, entetes: { ...entetes }, corps });
        res.writeHead(statut, entetes);
        res.end(corps);
      });
      return;
    }

    res.writeHead(statut, entetes);
    if (action) {
      const morceaux = [];
      reponse.on("data", (d) => morceaux.push(d));
      reponse.on("end", () => action.finir({ statut, entetes: { ...entetes }, corps: Buffer.concat(morceaux) }));
      reponse.on("error", () => action.finir(null));
    }
    reponse.pipe(res);
  });

  requete.on("error", (e) => {
    if (action) action.finir(null);
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(
      injecter(
        "<!doctype html><title>Amont injoignable</title><h1>Le serveur du site ne répond pas</h1>" +
          "<p>" + cible + " · " + e.message + "</p><p>Est-il lancé ? Sur ce port ?</p>",
        req,
      ),
    );
  });

  req.pipe(requete);
}

/**
 * WebSockets : indispensable pour le rechargement à chaud (Next, Vite).
 * On ouvre la même connexion vers l'amont et on relie les deux prises.
 */
function relayerUpgrade(req, prise, entete) {
  const requete = moduleAmont.request(optionsAmont(req));
  requete.on("upgrade", (reponse, priseAmont, enteteAmont) => {
    const lignes = ["HTTP/1.1 101 Switching Protocols"];
    for (const [k, v] of Object.entries(reponse.headers)) lignes.push(k + ": " + v);
    prise.write(lignes.join("\r\n") + "\r\n\r\n");
    if (enteteAmont?.length) prise.write(enteteAmont);
    if (entete?.length) priseAmont.write(entete);
    priseAmont.pipe(prise);
    prise.pipe(priseAmont);
    const fermer = () => {
      prise.destroy();
      priseAmont.destroy();
    };
    prise.on("error", fermer);
    priseAmont.on("error", fermer);
  });
  requete.on("error", () => prise.destroy());
  requete.end();
}

/* ----------------------------- commentaires ------------------------------ */

async function enregistrerPiece(nom, dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const ext = (m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5);
  // Sans l'extension d'origine : on la remet d'après le type réel de l'image.
  const sur =
    String(nom || "image")
      .replace(/\.[a-z0-9]{1,5}$/i, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 40) || "image";
  const fichier = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${sur}.${ext}`;
  await mkdir(DOSSIER_PIECES, { recursive: true });
  await writeFile(path.join(DOSSIER_PIECES, fichier), Buffer.from(m[2], "base64"));
  return path.join(".overlay", "attachments", fichier).split(path.sep).join("/");
}

function lireCorps(req, limite = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    req.on("data", (d) => {
      taille += d.length;
      if (taille > limite) {
        reject(new Error("corps trop volumineux"));
        req.destroy();
        return;
      }
      morceaux.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(morceaux).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, objet) {
  const corps = JSON.stringify(objet);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(corps) });
  res.end(corps);
}

async function recevoirCommentaires(req, res) {
  let corps;
  try {
    corps = JSON.parse(await lireCorps(req));
  } catch (e) {
    return json(res, 400, { error: "json invalide : " + e.message });
  }

  const entrants = Array.isArray(corps.comments) ? corps.comments : [];
  if (entrants.length === 0) return json(res, 400, { error: "aucun commentaire" });

  const commentaires = [];
  for (const c of entrants) {
    const pieces = [];
    for (const p of c.attachments ?? []) {
      const chemin = await enregistrerPiece(p.name, p.dataUrl);
      if (chemin) pieces.push(chemin);
    }
    commentaires.push({
      n: c.n,
      message: String(c.message ?? "").slice(0, 4000),
      target: c.target ?? {},
      attachments: pieces,
    });
  }

  await mkdir(DOSSIER_OVERLAY, { recursive: true });

  let existant = { batches: [] };
  try {
    existant = JSON.parse(await readFile(FICHIER_COMMENTAIRES, "utf8"));
    if (!Array.isArray(existant.batches)) existant.batches = [];
  } catch {
    /* premier lot */
  }

  const page = typeof corps.url === "string" ? corps.url : "/";

  // En statique, on sait quel fichier a servi la page : c'est le handle le plus
  // direct pour trouver le code, on l'écrit dans le lot.
  let fichier = null;
  if (dossier) {
    const f = resoudreFichier(page);
    if (f) fichier = path.relative(racine, f).split(path.sep).join("/");
  }

  existant.batches.push({
    id: crypto.randomBytes(4).toString("hex"),
    sentAt: new Date().toISOString(),
    page,
    fichier,
    status: "pending",
    comments: commentaires,
  });

  // Écriture atomique : le watcher ne doit jamais lire un fichier à moitié écrit.
  const tmp = `${FICHIER_COMMENTAIRES}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(existant, null, 2), "utf8");
  await rename(tmp, FICHIER_COMMENTAIRES);

  json(res, 200, { ok: true, received: commentaires.length });
}

/* ------------------------- synchronisation ------------------------------- */

/* Les téléphones s'abonnent en flux continu (Server-Sent Events). On garde la
   dernière page et le dernier défilement : un téléphone qui arrive en cours de
   route se cale aussitôt, sans attendre que la fenêtre principale bouge. */
const abonnes = new Set();
let dernierePage = null;
let dernierDefilement = null;

// Les états se gardent, et se rejouent au téléphone qui arrive. Les gestes de
// la fenêtre principale (clic, saisie, touche, défilement d'un élément) non.
const ETATS = ["page", "defilement", "stockage"];
const GESTES = ["clic", "saisie", "touche", "defilement-element"];

/* L'état du navigateur de la fenêtre principale : ses cookies et son
   localStorage. Chaque téléphone a son propre navigateur, vide : sans ce
   miroir, un choix fait dans la fenêtre principale n'existait pas dans les
   téléphones. Constaté le 2026-10-01 : le bandeau des cookies, refusé à gauche,
   restait affiché dans les deux iPhones. Même cause pour une connexion, un
   panier, un thème ou une langue retenus par le navigateur.

   Les cookies se lisent ici, dans l'entête `Cookie` de chaque envoi de la
   fenêtre principale : il contient aussi ceux que la page ne voit pas
   (HttpOnly), comme la session d'un compte. Le localStorage, la page l'envoie
   elle-même. Le sessionStorage reste à chaque navigateur : il ne dure qu'une
   visite, et l'overlay y range son propre état. */
let cookiesPrincipale = null;
let localPrincipale = null;
let dernierStockage = null;

function majStockage(cookies, local) {
  let change = false;
  if (typeof cookies === "string" && cookies !== cookiesPrincipale) {
    cookiesPrincipale = cookies;
    change = true;
  }
  if (local && typeof local === "object" && JSON.stringify(local) !== JSON.stringify(localPrincipale)) {
    localPrincipale = local;
    change = true;
  }
  if (!change) return;
  const contenu = { cookies: cookiesPrincipale || "", local: localPrincipale || {} };
  const version = crypto.createHash("sha1").update(JSON.stringify(contenu)).digest("hex").slice(0, 16);
  dernierStockage = { type: "stockage", ...contenu, version };
  diffuser(dernierStockage);
}

function diffuser(objet) {
  const ligne = `data: ${JSON.stringify(objet)}\n\n`;
  for (const r of abonnes) r.write(ligne);
}

function abonner(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": synchro\n\n");
  // L'état du navigateur d'abord : s'il oblige le téléphone à recharger, il
  // recharge une fois, avant de se caler sur la page et le défilement.
  if (dernierStockage) res.write(`data: ${JSON.stringify(dernierStockage)}\n\n`);
  if (dernierePage) res.write(`data: ${JSON.stringify(dernierePage)}\n\n`);
  if (dernierDefilement) res.write(`data: ${JSON.stringify(dernierDefilement)}\n\n`);
  abonnes.add(res);
  req.on("close", () => abonnes.delete(res));
}

async function publier(req, res) {
  let e;
  try {
    e = JSON.parse(await lireCorps(req, 512 * 1024));
  } catch {
    return json(res, 400, { error: "json invalide" });
  }
  if (![...ETATS, ...GESTES].includes(e.type)) return json(res, 400, { error: "type inconnu" });
  // Seule la fenêtre principale publie : ses cookies voyagent avec chaque envoi.
  majStockage(req.headers.cookie || "", e.type === "stockage" ? e.local : null);
  if (e.type === "page") {
    // Une nouvelle page rend l'ancien défilement caduc.
    if (!dernierePage || dernierePage.url !== e.url || dernierePage.id !== e.id) dernierDefilement = null;
    dernierePage = e;
    diffuser(e);
  } else if (e.type === "defilement") {
    dernierDefilement = e;
    diffuser(e);
  } else if (GESTES.includes(e.type)) {
    // Un geste se transmet et s'oublie : rejoué à un téléphone qui arrive plus
    // tard, un vieux clic refermerait ce qui est ouvert.
    diffuser(e);
  }
  json(res, 200, { ok: true, telephones: abonnes.size });
}

/** Ce que le serveur garde de l'état du navigateur, sans les valeurs : les noms
    suffisent pour vérifier, et une valeur de cookie peut être une session. */
function resumeStockage() {
  if (!dernierStockage) return null;
  const noms = dernierStockage.cookies
    .split(/;\s*/)
    .filter(Boolean)
    .map((c) => c.split("=")[0]);
  return { version: dernierStockage.version, cookies: noms, local: Object.keys(dernierStockage.local) };
}

// Un commentaire toutes les quinze secondes garde le flux ouvert à travers les
// intermédiaires qui coupent les connexions silencieuses.
setInterval(() => {
  for (const r of abonnes) r.write(": .\n\n");
}, 15000).unref();

/* ------------------------------- serveur --------------------------------- */

const serveur = http.createServer(async (req, res) => {
  try {
    const chemin = (req.url || "/").split("?")[0];

    if (chemin === "/__overlay/overlay.js" || chemin === "/__overlay/synchro.js" || chemin === "/__overlay/deplacer.js") {
      const fichier = chemin.endsWith("synchro.js") ? SCRIPT_SYNCHRO : chemin.endsWith("deplacer.js") ? SCRIPT_DEPLACER : SCRIPT_OVERLAY;
      const js = await readFile(fichier);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(js);
    }
    if (chemin === "/__overlay/synchro") return req.method === "POST" ? publier(req, res) : abonner(req, res);
    if (chemin === "/__overlay/synchro/etat") {
      return json(res, 200, {
        telephones: abonnes.size,
        page: dernierePage,
        defilement: dernierDefilement,
        stockage: resumeStockage(),
        actionsGardees: ACTIONS.length,
      });
    }
    if (chemin === "/__overlay/comments" && req.method === "POST") return recevoirCommentaires(req, res);
    if (chemin === "/__overlay/statut") {
      // L'état des lots. L'overlay interroge ici tant qu'un lot est `pending` :
      // Claude le passe à `en_cours` dès son réveil, et la comète s'arrête.
      let existant = { batches: [] };
      try {
        existant = JSON.parse(await readFile(FICHIER_COMMENTAIRES, "utf8"));
      } catch {
        /* aucun lot */
      }
      const lots = Array.isArray(existant.batches) ? existant.batches : [];
      return json(res, 200, {
        batches: lots.map((b) => ({ id: b.id, status: b.status, sentAt: b.sentAt, page: b.page })),
      });
    }
    if (chemin === "/__overlay/ping") return json(res, 200, { ok: true, mode: dossier ? "statique" : "proxy", racine });

    if (dossier) return servirStatique(req, res);
    return relayer(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Erreur du serveur d'overlay : " + e.message);
  }
});

if (amont) serveur.on("upgrade", relayerUpgrade);

let essais = 0;
serveur.on("error", (e) => {
  if (e.code === "EADDRINUSE" && essais < 20) {
    essais++;
    port++;
    serveur.listen(port);
    return;
  }
  console.error("Impossible d'écouter : " + e.message);
  process.exit(1);
});

serveur.on("listening", () => {
  console.log(`[overlay] ${dossier ? "statique : " + dossier : "proxy → " + cible}`);
  if (projetBuildyoursite) {
    console.log("[overlay] projet /buildyoursite : son overlay est déjà dans le site, seule la synchronisation des téléphones est injectée");
    console.log(`[overlay] commentaires : ${path.join(racine, ".buildyoursite", "comments.json")}`);
  } else {
    console.log(`[overlay] commentaires : ${FICHIER_COMMENTAIRES}`);
  }
  console.log(`OVERLAY_URL=http://localhost:${port}`);
});

serveur.listen(port);
