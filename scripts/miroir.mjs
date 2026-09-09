#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Miroir : copie locale d'un site dont on n'a que l'adresse.

   À n'utiliser que sur un site qui appartient à l'utilisateur. Copier le site
   d'un tiers pour le modifier est une contrefaçon, quel que soit le prétexte :
   le skill pose la question avant, ce script ne la pose pas à sa place.

   Ce que ça produit : les pages HTML telles que le serveur les rend, leurs
   feuilles de style, scripts, images et polices du même domaine, avec les
   adresses absolues réécrites en relatives pour que le dossier se serve seul.

   Ce que ça n'est PAS : la source. Un site généré côté navigateur (React, Wix,
   Framer…) livre un HTML presque vide qui se remplit en JavaScript ; sa copie
   est un squelette. Le script le détecte et le dit.

   Usage :
     node miroir.mjs --url https://son-site.fr --sortie ./son-site
       [--profondeur 1]   pages suivies depuis l'accueil (0 = l'accueil seul)
       [--max 60]         nombre maximum de pages
--------------------------------------------------------------------------- */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf("--" + n);
  return i >= 0 ? args[i + 1] : d;
};

const depart = opt("url");
const sortie = opt("sortie");
const profondeurMax = Number(opt("profondeur", 1));
const pagesMax = Number(opt("max", 60));

if (!depart || !sortie) {
  console.error("Usage : node miroir.mjs --url https://son-site.fr --sortie ./dossier [--profondeur 1] [--max 60]");
  process.exit(1);
}

let origineUrl;
try {
  origineUrl = new URL(depart);
} catch {
  console.error("URL invalide : " + depart);
  process.exit(1);
}
const ORIGINE = origineUrl.origin;
const DOSSIER = path.resolve(sortie);
const UA = "Mozilla/5.0 (compatible; buildyoursite-overlay-miroir/1.0)";

/* -------------------------------- helpers -------------------------------- */

const IGNORER = /^(data:|mailto:|tel:|javascript:|#|blob:)/i;

/** Résout une référence trouvée dans une page ; null si hors domaine ou inutile. */
function resoudre(ref, base) {
  if (!ref || IGNORER.test(ref.trim())) return null;
  try {
    const u = new URL(ref.trim(), base);
    if (u.origin !== ORIGINE) return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

/** Chemin local d'une URL du site. `/tarifs` → tarifs/index.html ; `/a.css?v=2` → a.css */
function cheminLocal(u, html) {
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    p = u.pathname;
  }
  if (p.endsWith("/")) p += "index.html";
  else if (html && !/\.[a-z0-9]{2,5}$/i.test(p)) p += "/index.html";
  const segments = p.split("/").filter(Boolean).map((s) => s.replace(/[<>:"|?*\\]/g, "_"));
  return path.join(DOSSIER, ...segments);
}

/** Absolu → relatif à la racine, pour que le dossier se serve tel quel. */
function relativiser(texte) {
  const hote = ORIGINE.replace(/^https?:/, "");
  return texte
    .split(ORIGINE + "/").join("/")
    .split(ORIGINE).join("/")
    .split(hote + "/").join("/");
}

async function telecharger(u) {
  const controle = new AbortController();
  const minuterie = setTimeout(() => controle.abort(), 30000);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: controle.signal });
    if (!r.ok) return null;
    return { corps: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "" };
  } catch {
    return null;
  } finally {
    clearTimeout(minuterie);
  }
}

// La borne devant exclut `data-src=` et consorts : un `data-src="app/page.tsx"`
// n'est pas une image à télécharger.
const RE_ATTR = /(?<![\w-])(?:href|src|poster)\s*=\s*["']([^"']+)["']/gi;
const RE_SRCSET = /srcset\s*=\s*["']([^"']+)["']/gi;
const RE_CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const RE_CSS_IMPORT = /@import\s+["']([^"']+)["']/gi;

function referencesHtml(html, base) {
  const pages = new Set();
  const actifs = new Set();
  for (const m of html.matchAll(RE_ATTR)) {
    const u = resoudre(m[1], base);
    if (!u) continue;
    const brut = m[0].toLowerCase();
    // Un href sans extension de fichier est une page ; le reste, un actif.
    const estPage = brut.startsWith("href") && !/\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|pdf|xml|json|mp4|webm|mp3)$/i.test(u.pathname);
    if (estPage) {
      // Les liens de la balise <link> (feuilles de style, icônes) ne sont pas des pages.
      const debut = html.lastIndexOf("<", m.index);
      const balise = html.slice(debut, m.index).toLowerCase();
      if (balise.startsWith("<link")) actifs.add(u.href);
      else pages.add(u.href);
    } else actifs.add(u.href);
  }
  for (const m of html.matchAll(RE_SRCSET)) {
    for (const part of m[1].split(",")) {
      const u = resoudre(part.trim().split(/\s+/)[0], base);
      if (u) actifs.add(u.href);
    }
  }
  for (const m of html.matchAll(RE_CSS_URL)) {
    const u = resoudre(m[1], base);
    if (u) actifs.add(u.href);
  }
  return { pages, actifs };
}

function referencesCss(css, base) {
  const actifs = new Set();
  for (const re of [RE_CSS_URL, RE_CSS_IMPORT]) {
    for (const m of css.matchAll(re)) {
      const u = resoudre(m[1], base);
      if (u) actifs.add(u.href);
    }
  }
  return actifs;
}

/** Texte visible approximatif : pour repérer un site rendu côté navigateur. */
function texteVisible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------- parcours ------------------------------- */

const pagesVues = new Set();
const actifsVus = new Set();
// Les échecs sont résumés à la fin : un site Next en dev en produit des dizaines
// (optimiseur d'images, chunks à la demande) et ils noieraient les pages réussies.
const echecs = [];
const file = [{ url: origineUrl.href, profondeur: 0 }];
let octets = 0;
let squeletteSignale = false;

async function enregistrer(chemin, corps) {
  await mkdir(path.dirname(chemin), { recursive: true });
  await writeFile(chemin, corps);
  octets += corps.length;
}

async function traiterActif(href) {
  if (actifsVus.has(href) || actifsVus.size > 800) return;
  actifsVus.add(href);
  const u = new URL(href);
  const t = await telecharger(u);
  if (!t) {
    echecs.push(u.pathname);
    return;
  }
  const chemin = cheminLocal(u, false);
  if (/text\/css/i.test(t.type) || u.pathname.endsWith(".css")) {
    const css = t.corps.toString("utf8");
    for (const a of referencesCss(css, u.href)) await traiterActif(a);
    await enregistrer(chemin, Buffer.from(relativiser(css), "utf8"));
  } else {
    await enregistrer(chemin, t.corps);
  }
}

while (file.length > 0 && pagesVues.size < pagesMax) {
  const { url, profondeur } = file.shift();
  if (pagesVues.has(url)) continue;
  pagesVues.add(url);

  const t = await telecharger(url);
  if (!t) {
    echecs.push(new URL(url).pathname);
    continue;
  }
  if (!/text\/html/i.test(t.type)) {
    // Un « lien de page » qui rend autre chose (un PDF, une image) : c'est un actif.
    actifsVus.delete(url);
    await traiterActif(url);
    continue;
  }

  const html = t.corps.toString("utf8");
  const u = new URL(url);
  console.log("  ✓ " + (u.pathname || "/"));

  if (!squeletteSignale && texteVisible(html).length < 300) {
    squeletteSignale = true;
    console.log("\n  ⚠ Cette page contient presque aucun texte : le site est probablement rendu côté");
    console.log("    navigateur (React, Wix, Framer…). La copie sera un squelette : l'édition doit");
    console.log("    passer par la vraie source ou l'outil d'origine.\n");
  }

  const refs = referencesHtml(html, url);
  for (const a of refs.actifs) await traiterActif(a);
  if (profondeur < profondeurMax) {
    for (const p of refs.pages) if (!pagesVues.has(p)) file.push({ url: p, profondeur: profondeur + 1 });
  }

  const propre = relativiser(html).replace(/<base\s[^>]*>/gi, "");
  await enregistrer(cheminLocal(u, true), Buffer.from(propre, "utf8"));
}

if (echecs.length > 0) {
  const distincts = [...new Set(echecs)];
  console.log(
    `  ✗ ${echecs.length} fichier(s) non récupéré(s)` +
      (distincts.length > 5 ? ` : par exemple ${distincts.slice(0, 5).join(", ")} …` : ` : ${distincts.join(", ")}`),
  );
}
console.log(
  `\n${pagesVues.size} page(s), ${actifsVus.size - echecs.length} fichier(s) lié(s), ${(octets / 1024 / 1024).toFixed(1)} Mo → ${DOSSIER}`,
);
console.log("Copie de rendu, pas la source : ce qui est modifié ici doit être reporté par l'utilisateur.");
