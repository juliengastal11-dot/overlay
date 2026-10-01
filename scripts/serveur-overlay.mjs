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
   téléphones flottants (scripts/telephones.mjs) : la fenêtre publie sa page et
   son défilement sur POST /__overlay/synchro, les téléphones les reçoivent en
   flux continu sur GET /__overlay/synchro.

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

/* Un projet /buildyoursite rend son propre overlay, en React, après
   l'hydratation : notre script, qui vérifie sa présence à son chargement,
   arriverait avant lui et en monterait un second. On le reconnaît donc au
   disque, et on n'injecte que la synchronisation. */
const projetBuildyoursite = existsSync(path.join(racine, "components", "buildyoursite", "overlay.tsx"));
const sansOverlay = args.includes("--sans-overlay") || projetBuildyoursite;

// La synchronisation passe en premier : dans un téléphone, elle lève le drapeau
// qui empêche overlay.js de se monter.
const BALISE =
  '<script src="/__overlay/synchro.js" defer></script>' +
  (sansOverlay ? "" : '<script src="/__overlay/overlay.js" defer></script>');

/* ------------------------------ injection -------------------------------- */

/**
 * Pose le script juste avant </body>. À défaut, avant </html>, à défaut à la fin.
 *
 * Une politique de sécurité (CSP) déclarée dans une balise <meta> bloquerait le
 * script injecté : on la retire. Uniquement ici, en local, pour l'édition. Ce
 * n'est pas une modification du site, seulement de ce que le panneau en voit.
 */
function injecter(html) {
  let h = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, "");
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
    res.end(injecter("<!doctype html><title>404</title><h1>Introuvable</h1><p>" + req.url + "</p>"));
    return;
  }
  const ext = path.extname(fichier).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";

  if (ext === ".html" || ext === ".htm") {
    const html = await readFile(fichier, "utf8");
    const corps = Buffer.from(injecter(html), "utf8");
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

function relayer(req, res) {
  const requete = moduleAmont.request(optionsAmont(req), (reponse) => {
    const entetes = { ...reponse.headers };
    delete entetes["content-security-policy"];
    delete entetes["content-security-policy-report-only"];

    // On n'injecte que dans du HTML non compressé. Si l'amont a compressé malgré
    // la demande, on laisse passer tel quel plutôt que de corrompre la réponse.
    if (estHtml(entetes["content-type"]) && !entetes["content-encoding"]) {
      const morceaux = [];
      reponse.on("data", (d) => morceaux.push(d));
      reponse.on("end", () => {
        const corps = Buffer.from(injecter(Buffer.concat(morceaux).toString("utf8")), "utf8");
        entetes["content-length"] = String(corps.length);
        delete entetes["transfer-encoding"];
        res.writeHead(reponse.statusCode || 200, entetes);
        res.end(corps);
      });
      return;
    }

    res.writeHead(reponse.statusCode || 200, entetes);
    reponse.pipe(res);
  });

  requete.on("error", (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(
      injecter(
        "<!doctype html><title>Amont injoignable</title><h1>Le serveur du site ne répond pas</h1>" +
          "<p>" + cible + " · " + e.message + "</p><p>Est-il lancé ? Sur ce port ?</p>",
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
  if (dernierePage) res.write(`data: ${JSON.stringify(dernierePage)}\n\n`);
  if (dernierDefilement) res.write(`data: ${JSON.stringify(dernierDefilement)}\n\n`);
  abonnes.add(res);
  req.on("close", () => abonnes.delete(res));
}

async function publier(req, res) {
  let e;
  try {
    e = JSON.parse(await lireCorps(req, 64 * 1024));
  } catch {
    return json(res, 400, { error: "json invalide" });
  }
  if (e.type === "page") {
    // Une nouvelle page rend l'ancien défilement caduc.
    if (!dernierePage || dernierePage.url !== e.url || dernierePage.id !== e.id) dernierDefilement = null;
    dernierePage = e;
  } else if (e.type === "defilement") {
    dernierDefilement = e;
  } else {
    return json(res, 400, { error: "type inconnu" });
  }
  diffuser(e);
  json(res, 200, { ok: true, telephones: abonnes.size });
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

    if (chemin === "/__overlay/overlay.js" || chemin === "/__overlay/synchro.js") {
      const js = await readFile(chemin.endsWith("synchro.js") ? SCRIPT_SYNCHRO : SCRIPT_OVERLAY);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(js);
    }
    if (chemin === "/__overlay/synchro") return req.method === "POST" ? publier(req, res) : abonner(req, res);
    if (chemin === "/__overlay/synchro/etat") {
      return json(res, 200, { telephones: abonnes.size, page: dernierePage, defilement: dernierDefilement });
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
