/* ---------------------------------------------------------------------------
   Les téléphones flottants de /overlay : processus principal Electron.

   Deux iPhones, chacun dans sa propre fenêtre système, transparente et sans
   cadre : on ne voit que l'appareil, qui flotte sur le bureau. Le site s'affiche
   dans l'écran avec la fenêtre exacte du téléphone : 402 ou 440 pixels CSS de
   large, la hauteur visible de Safari, un écran tactile sans survol, l'agent
   utilisateur de Safari. Ce n'est pas le moteur de Safari, c'est celui de
   Chrome : la mise en page, les points de rupture et les media queries sont
   ceux du téléphone, le rendu des polices peut différer d'un cheveu.

   Pourquoi pas l'émulation d'appareil de Chrome : dans une vue intégrée, toute
   commande d'émulation fait planter ce moteur (Electron 44, vérifié le
   2026-10-01, par le protocole de débogage comme par l'API d'Electron). On
   obtient la même fenêtre autrement : la vue mesure exactement la largeur du
   téléphone, le zoom porte l'échelle, et deux réglages du moteur déclarent un
   pointeur tactile sans survol. Seule la densité d'écran reste celle du
   moniteur au lieu de 3 : elle ne change pas la mise en page.

   Le site est chargé à travers le serveur d'overlay, qui y injecte `synchro.js`.
   C'est ce script, dans la page, qui suit la fenêtre principale : défilement,
   changement de page, rechargement. Ce processus-ci ne fait que la vitrine.

   Lancé par `scripts/telephones.mjs`, jamais à la main :
     --tel-url <OVERLAY_URL>     le serveur d'overlay
     --tel-appareils standard,max
     --tel-echelle <0..1>        forcer l'échelle (défaut : 1, réduite si l'écran est trop petit)
     --tel-journal               écrire les événements sur la sortie standard
     --tel-capture <dossier>     enregistrer une capture d'écran de chaque téléphone
     --tel-quitter               quitter après la capture
--------------------------------------------------------------------------- */
"use strict";

const { app, BrowserWindow, WebContentsView, ipcMain, screen, desktopCapturer } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Un nom propre : profil, cache et verrou d'instance unique à part, sans croiser
// une autre application Electron de la machine.
app.setName("overlay-telephones");
if (process.platform === "win32") app.setAppUserModelId("overlay.telephones");

// Un téléphone n'a ni souris ni survol : `(hover: none)` et `(pointer: coarse)`
// doivent répondre vrai, et `ontouchstart` exister. À poser avant le démarrage.
app.commandLine.appendSwitch("touch-events", "enabled");
app.commandLine.appendSwitch(
  "blink-settings",
  "primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
);

const ICI = __dirname;
const FICHE = JSON.parse(fs.readFileSync(path.join(ICI, "appareils.json"), "utf8"));
const DONNEES = process.env.OVERLAY_DATA || path.join(os.homedir(), ".claude", "overlay");
const FICHIER_POSITIONS = path.join(DONNEES, "telephones.json");

/* Marges autour du boîtier, en points : l'ombre qui le fait flotter, les
   commandes au-dessus, la légende en dessous. Le reste de la fenêtre est
   transparent et laisse passer les clics. */
const MARGE = { g: 48, d: 48, h: 64, b: 86 };

/* Les options arrivent sous la forme `--nom=valeur`. Pas `--nom valeur` : un
   chemin Windows passé en argument séparé (« C:/… ») fait échouer le démarrage
   d'Electron avant la première ligne de ce fichier. Vérifié le 2026-10-01. */
function option(argv, nom, defaut = null) {
  const prefixe = "--" + nom + "=";
  const avecEgal = argv.find((a) => a.startsWith(prefixe));
  if (avecEgal) return avecEgal.slice(prefixe.length);
  return argv.includes("--" + nom) ? true : defaut;
}

const ARGV = process.argv;
let urlSite = option(ARGV, "tel-url");
const listeAppareils = String(option(ARGV, "tel-appareils", "standard,max"))
  .split(",")
  .map((s) => s.trim())
  .filter((s) => FICHE.appareils[s]);
const echelleForcee = option(ARGV, "tel-echelle") ? Number(option(ARGV, "tel-echelle")) : null;
const journal = !!option(ARGV, "tel-journal");
const dossierCapture = option(ARGV, "tel-capture");
const quitterApres = !!option(ARGV, "tel-quitter");

function log(...m) {
  if (journal) console.log("[telephones]", ...m);
}

// Une erreur dans une promesse ne doit pas passer en silence : c'est elle qui
// laisserait l'utilisateur devant un écran vide sans explication.
process.on("unhandledRejection", (e) => console.error("[telephones] erreur :", e && e.stack ? e.stack : e));
process.on("uncaughtException", (e) => console.error("[telephones] erreur :", e && e.stack ? e.stack : e));

if (!urlSite) {
  console.error("[telephones] --tel-url manquant : l'adresse du serveur d'overlay");
  app.exit(2);
}

/* Une seule instance : relancer le script ne double pas les téléphones, il
   rouvre ceux qu'on avait fermés et suit la nouvelle adresse s'il y en a une. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const telephones = new Map(); // id → { win, vue, ap, G, teinte }

/* ------------------------------ positions -------------------------------- */

function lirePositions() {
  try {
    return JSON.parse(fs.readFileSync(FICHIER_POSITIONS, "utf8"));
  } catch {
    return {};
  }
}

function ecrirePositions() {
  const p = {};
  for (const [id, t] of telephones) {
    if (!t.win.isDestroyed()) {
      const b = t.win.getBounds();
      p[id] = { x: b.x, y: b.y };
    }
  }
  try {
    fs.mkdirSync(DONNEES, { recursive: true });
    fs.writeFileSync(FICHIER_POSITIONS, JSON.stringify(p, null, 2));
  } catch {
    /* une position perdue n'est pas une panne */
  }
}

function visible(rect) {
  return screen.getAllDisplays().some((d) => {
    const z = d.workArea;
    return rect.x + 80 > z.x && rect.x + rect.width - 80 < z.x + z.width + rect.width && rect.y > z.y - 40 && rect.y < z.y + z.height - 120;
  });
}

/* ------------------------------ géométrie -------------------------------- */

/** Tout en pixels de fenêtre. Une seule source de vérité : la page du boîtier
    et la vue du site se calent sur les mêmes nombres.

    L'échelle demandée (k) est d'abord ajustée pour que la largeur de l'écran
    tombe sur un nombre entier de pixels : sans ça, 402 × 0,9009 donne 362,2,
    arrondi à 362, et la page ne voit plus que 401 pixels. Constaté. Chaque
    téléphone a donc sa propre échelle, à quelques millièmes de l'autre. */
function geometrie(ap, kDemande) {
  const largeurEcran = Math.round(ap.ecran.l * kDemande);
  const k = largeurEcran / ap.ecran.l;
  const p = (v) => Math.round(v * k);
  const b = ap.bordure;
  const lB = ap.ecran.l + 2 * b;
  const hB = ap.ecran.h + 2 * b;
  const boitier = { x: p(MARGE.g), y: p(MARGE.h), l: p(lB), h: p(hB), r: p(ap.rayonEcran + b) };
  const ecran = { x: p(MARGE.g + b), y: p(MARGE.h + b), l: largeurEcran, h: p(ap.ecran.h), r: p(ap.rayonEcran) };
  // La hauteur de la vue part de la hauteur CSS voulue, arrondie au-dessus, pour
  // qu'une fois le zoom posé la page voie bien 766 ou 848 pixels.
  const hautVue = p(MARGE.h + b + ap.statut);
  const vue = { x: ecran.x, y: hautVue, l: ecran.l, h: Math.ceil((ap.ecran.h - ap.statut - ap.bas) * k) };
  const boutons = ap.boutons.map((bt) => ({
    cote: bt.cote,
    type: bt.type,
    y: boitier.y + Math.round(hB * bt.haut * k),
    h: Math.round(hB * bt.hauteur * k),
  }));
  return {
    k,
    id: ap.id,
    nom: ap.nom,
    finition: ap.finition,
    largeurCss: ap.ecran.l,
    fen: { l: p(lB + MARGE.g + MARGE.d), h: p(hB + MARGE.h + MARGE.b) },
    boitier,
    tranche: Math.max(2, p(ap.tranche)),
    ecran,
    vue,
    ile: { l: p(ap.ile.l), h: p(ap.ile.h), haut: p(ap.ile.haut) },
    boutons,
  };
}

function echelle(appareils) {
  if (echelleForcee && echelleForcee > 0) return Math.min(1, echelleForcee);
  const zone = screen.getPrimaryDisplay().workArea;
  const plusHaut = Math.max(...appareils.map((ap) => ap.ecran.h + 2 * ap.bordure + MARGE.h + MARGE.b));
  return Math.min(1, (zone.height - 8) / plusHaut);
}

/* --------------------------- fenêtre du site ----------------------------- */

/** La vue mesure la largeur du téléphone multipliée par l'échelle ; le zoom
    à la même échelle rend à la page sa largeur exacte en pixels CSS. Vérifié :
    402 de large à 100 % comme à 90 %. Le zoom se repose à chaque chargement,
    Chrome le rattachant à l'origine plutôt qu'à la vue. */
function caler(wc, G) {
  // Un cent-millième de moins : la largeur vue par la page devient 402,004 et
  // non 401,9999 qu'un arrondi vers le bas ramènerait à 401.
  const zoom = G.k * 0.99999;
  if (!wc.isDestroyed() && Math.abs(wc.getZoomFactor() - zoom) > 1e-7) wc.setZoomFactor(zoom);
}

/* Un iPhone n'affiche pas de barre de défilement permanente : celle de Chrome,
   avec ses flèches, trahirait l'ordinateur et volerait quinze pixels de large.
   Et le badge du serveur de développement de Next n'existe pas pour un visiteur :
   le téléphone montre le site, pas l'atelier. */
const SANS_BARRE =
  "html{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}" +
  "nextjs-portal{display:none!important}";

/* La teinte de la barre d'état. Safari la prend dans `theme-color`, sinon dans
   la couleur du haut de la page ; la barre du bas suit le bas de la page. */
const SONDE = `(() => {
  const vide = (c) => !c || c === "transparent" || /^rgba\\(\\s*0,\\s*0,\\s*0,\\s*0\\s*\\)$/.test(c);
  const fondSous = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (!vide(c)) return c;
      el = el.parentElement;
    }
    const b = document.body ? getComputedStyle(document.body).backgroundColor : null;
    const h = getComputedStyle(document.documentElement).backgroundColor;
    return !vide(b) ? b : !vide(h) ? h : "rgb(255, 255, 255)";
  };
  const meta = document.querySelector('meta[name="theme-color"]');
  return { haut: (meta && meta.content) || fondSous(innerWidth / 2, 1), bas: fondSous(innerWidth / 2, innerHeight - 2) };
})()`;

// Pour le journal : où en est le téléphone, et quelle section d'ancre est en haut de son écran.
const ETAT_VUE = `[Math.round(scrollY), document.documentElement.scrollHeight, innerWidth, innerHeight,
  matchMedia("(hover: none)").matches, matchMedia("(pointer: coarse)").matches, devicePixelRatio,
  location.pathname + ([...document.querySelectorAll("section[id], [id]")].filter((e) => e.getBoundingClientRect().top <= 80).map((e) => "#" + e.id).pop() || "")]`;

/* ------------------------------ téléphones ------------------------------- */

function creer(id, k, position) {
  const ap = { id, ...FICHE.appareils[id] };
  const G = geometrie(ap, k);
  const domaine = (() => {
    try {
      return new URL(urlSite).hostname;
    } catch {
      return "localhost";
    }
  })();

  const win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: G.fen.l,
    height: G.fen.h,
    title: ap.nom,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    hasShadow: false,
    thickFrame: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(ICI, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");

  const vue = new WebContentsView({
    // Une session par téléphone : Chrome attache le zoom à l'adresse du site, et
    // deux téléphones d'échelles différentes sur la même adresse se le
    // disputeraient. Et deux vrais téléphones n'ont pas les mêmes cookies.
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      zoomFactor: G.k * 0.99999,
      partition: "overlay-telephone-" + id,
    },
  });
  vue.setBackgroundColor("#ffffff");
  win.contentView.addChildView(vue);
  vue.setBounds({ x: G.vue.x, y: G.vue.y, width: G.vue.l, height: G.vue.h });

  const t = { win, vue, ap, G, teinte: null, etat: null };
  telephones.set(id, t);

  win.loadFile(path.join(ICI, "telephone.html"), {
    query: { g: JSON.stringify(G), domaine },
  });
  win.once("ready-to-show", () => win.showInactive());
  win.on("moved", ecrirePositions);
  win.on("closed", () => {
    telephones.delete(id);
  });

  const wc = vue.webContents;
  wc.setUserAgent(FICHE.agentUtilisateur);
  wc.on("dom-ready", () => {
    caler(wc, G);
    wc.insertCSS(SANS_BARRE).catch(() => {});
  });
  wc.loadURL(urlSite);

  let relance = null;
  wc.on("did-fail-load", (_e, code, desc, url, principal) => {
    if (!principal || code === -3) return; // -3 : navigation interrompue, normal
    log(id, "échec de chargement", code, desc, url);
    clearTimeout(relance);
    relance = setTimeout(() => !wc.isDestroyed() && wc.loadURL(urlSite), 2000);
  });
  wc.on("did-finish-load", () => {
    caler(wc, G);
    log(id, "chargé", wc.getURL());
    sonder(t);
  });
  wc.on("did-navigate-in-page", () => sonder(t));
  wc.on("render-process-gone", (_e, d) => {
    log(id, "rendu interrompu", d.reason);
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000);
  });
  wc.setWindowOpenHandler(({ url }) => {
    // Un lien qui ouvre un nouvel onglet reste dans le téléphone, comme Safari.
    wc.loadURL(url);
    return { action: "deny" };
  });

  return t;
}

async function sonder(t) {
  if (t.vue.webContents.isDestroyed() || t.win.isDestroyed()) return;
  try {
    const teinte = await t.vue.webContents.executeJavaScript(SONDE, true);
    const cle = JSON.stringify(teinte);
    if (cle !== t.teinte) {
      t.teinte = cle;
      t.win.webContents.send("teinte", teinte);
    }
  } catch {
    /* page en cours de chargement */
  }
  if (journal) {
    try {
      const etat = await t.vue.webContents.executeJavaScript(ETAT_VUE, true);
      const cle = JSON.stringify(etat);
      if (cle !== t.etat) {
        t.etat = cle;
        const [y, hauteur, l, h, survolAucun, pointeurGrossier, dpr, chemin] = etat;
        log(t.ap.id, `défilement ${y}/${hauteur - h}`, `fenêtre ${l}×${h}`, `dpr ${dpr}`, `hover:none ${survolAucun}`, `pointer:coarse ${pointeurGrossier}`, chemin);
      }
    } catch {
      /* idem */
    }
  }
}

function positionsParDefaut(ids, k) {
  const zone = screen.getPrimaryDisplay().workArea;
  const tailles = ids.map((id) => geometrie({ id, ...FICHE.appareils[id] }, k).fen);
  const total = tailles.reduce((s, f) => s + f.l, 0);
  let x = zone.x + Math.max(0, zone.width - total - 12);
  return ids.map((id, i) => {
    const f = tailles[i];
    const pos = { x, y: zone.y + Math.max(0, Math.round((zone.height - f.h) / 2)) };
    x += f.l;
    return pos;
  });
}

function ouvrirTout() {
  const ids = listeAppareils.filter((id) => !telephones.has(id));
  if (ids.length === 0) return;
  const k = echelle(listeAppareils.map((id) => FICHE.appareils[id]));
  const memo = lirePositions();
  const defauts = positionsParDefaut(listeAppareils, k);
  for (const id of ids) {
    const i = listeAppareils.indexOf(id);
    const G = geometrie({ id, ...FICHE.appareils[id] }, k);
    const m = memo[id];
    const pos = m && visible({ x: m.x, y: m.y, width: G.fen.l, height: G.fen.h }) ? m : defauts[i];
    creer(id, k, pos);
  }
  log(`échelle ${Math.round(k * 100)} %`, ids.join(", "));
}

/* ------------------------------- capture --------------------------------- */

/** Capture de l'écran réel, découpée sur chaque téléphone : ce que l'utilisateur
    voit, ombre et bureau compris. Sert à vérifier le rendu sans le regarder. */
async function capturer(dossier) {
  fs.mkdirSync(dossier, { recursive: true });
  const fichiers = [];
  for (const [id, t] of telephones) {
    if (t.win.isDestroyed()) continue;
    const b = t.win.getBounds();
    const d = screen.getDisplayMatching(b);
    const f = d.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(d.size.width * f), height: Math.round(d.size.height * f) },
    });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src) continue;
    const zone = {
      x: Math.max(0, Math.round((b.x - d.bounds.x) * f)),
      y: Math.max(0, Math.round((b.y - d.bounds.y) * f)),
      width: Math.round(b.width * f),
      height: Math.round(b.height * f),
    };
    const fichier = path.join(dossier, id + ".png");
    fs.writeFileSync(fichier, src.thumbnail.crop(zone).toPNG());
    fichiers.push(fichier);
  }
  console.log("[telephones] captures : " + fichiers.join(" , "));
}

/* --------------------------------- vie ----------------------------------- */

ipcMain.on("fermer", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
});
ipcMain.on("traverser", (e, v) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!!v, { forward: true });
});

app.on("second-instance", (_e, argv) => {
  const nouvelle = option(argv, "tel-url");
  if (nouvelle && nouvelle !== true && nouvelle !== urlSite) {
    urlSite = nouvelle;
    for (const t of telephones.values()) t.vue.webContents.loadURL(urlSite);
  }
  ouvrirTout();
  for (const t of telephones.values()) if (!t.win.isDestroyed()) t.win.showInactive();
  // Une capture demandée pendant que les téléphones tournent : on la fait ici,
  // sur l'état courant, sans les fermer.
  const capture = option(argv, "tel-capture");
  if (capture && capture !== true) setTimeout(() => capturer(capture).catch((e) => console.error("[telephones] capture impossible :", e.message)), 400);
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  ouvrirTout();
  console.log("[telephones] prêts : " + listeAppareils.map((id) => FICHE.appareils[id].nom).join(" et "));
  setInterval(() => {
    for (const t of telephones.values()) sonder(t);
  }, 1500);
  setInterval(() => {
    const maintenant = new Date();
    for (const t of telephones.values()) if (!t.win.isDestroyed()) t.win.webContents.send("heure", maintenant.toISOString());
  }, 15000);
  if (dossierCapture && dossierCapture !== true) {
    const delai = Number(option(ARGV, "tel-capture-delai", 4000));
    setTimeout(async () => {
      try {
        await capturer(dossierCapture);
      } catch (e) {
        console.error("[telephones] capture impossible :", e.message);
      }
      if (quitterApres) app.quit();
    }, delai);
  }
});
