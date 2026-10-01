/* ---------------------------------------------------------------------------
   Les téléphones flottants de /overlay : processus principal Electron.

   Deux iPhones, chacun dans sa propre fenêtre système, transparente et sans
   cadre : on ne voit que l'appareil, qui flotte sur le bureau. Ils ont la
   taille d'un vrai iPhone, au millimètre : le boîtier d'un iPhone 17 mesure
   71,5 × 149,6 mm sur l'écran comme dans la main. Le site s'affiche dans
   l'écran avec la fenêtre exacte du téléphone : 402 ou 440 pixels CSS de
   large, la hauteur visible de Safari, un écran tactile sans survol, l'agent
   utilisateur de Safari. Ce n'est pas le moteur de Safari, c'est celui de
   Chrome : la mise en page, les points de rupture et les media queries sont
   ceux du téléphone, le rendu des polices peut différer d'un cheveu.

   La taille réelle. Un point d'iPhone mesure 0,166 mm, un pixel de moniteur
   entre 0,2 et 0,3. Dessiner un point par pixel donnait des téléphones une
   fois et demie à deux fois trop grands : constaté le 2026-10-01 sur un
   27 pouces en 1920 × 1080, où ils prenaient tout l'écran. On part donc de la
   taille physique de chaque écran, mesurée par ecrans.ps1 dans sa fiche EDID,
   et l'échelle se recalcule quand on pose un téléphone sur un autre écran.

   Pourquoi pas l'émulation d'appareil de Chrome : dans une vue intégrée, toute
   commande d'émulation fait planter ce moteur (Electron 44, vérifié le
   2026-10-01, par le protocole de débogage comme par l'API d'Electron). On
   obtient la même fenêtre autrement : la vue a la largeur du téléphone à
   l'échelle, le zoom à la même échelle rend à la page sa largeur exacte, et
   deux réglages du moteur déclarent un pointeur tactile sans survol. Seule la
   densité d'écran reste celle du moniteur : elle ne change pas la mise en page.

   Le site est chargé à travers le serveur d'overlay, qui y injecte `synchro.js`.
   C'est ce script, dans la page, qui suit la fenêtre principale : défilement,
   changement de page, rechargement. Ce processus-ci ne fait que la vitrine.

   Lancé par `scripts/telephones.mjs`, jamais à la main :
     --tel-url=<OVERLAY_URL>      le serveur d'overlay
     --tel-appareils=standard,max
     --tel-echelle=<n>            multiple de la taille réelle (défaut : 1)
     --tel-ecrans=<liste>         taille physique des écrans, mesurée par ecrans.ps1
     --tel-claude=<x:y:l:h>       la fenêtre de Claude, pour ne pas la couvrir
     --tel-diagonale=<pouces>     diagonale de l'écran, si la mesure manque ou se trompe
     --tel-journal                écrire les événements sur la sortie standard
     --tel-capture=<dossier>      enregistrer une capture d'écran de chaque téléphone
     --tel-quitter                quitter après la capture
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

/* Marges autour du boîtier, en pixels de fenêtre : l'ombre qui le fait flotter,
   les commandes au-dessus, la légende en dessous. Fixes et non proportionnelles
   au téléphone : à la taille réelle, une marge proportionnelle ne laissait plus
   de place aux commandes. Le reste de la fenêtre est transparent et laisse
   passer les clics. */
const MARGE = { g: 30, d: 30, h: 46, b: 64 };

/* Densité de repli quand la taille de l'écran est inconnue : 96 pixels par
   pouce, la référence de Windows à 100 %. Juste à 15 % près sur la plupart des
   écrans de bureau ; la légende dit alors « taille estimée ». */
const PX_PAR_MM_DEFAUT = 96 / 25.4;

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
const nombre = (nom) => {
  const v = Number(option(ARGV, nom));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const echelleDemandee = nombre("tel-echelle") || 1;
const diagonale = nombre("tel-diagonale");
const journal = !!option(ARGV, "tel-journal");
const dossierCapture = option(ARGV, "tel-capture");
const quitterApres = !!option(ARGV, "tel-quitter");

/* Les écrans tels que les a mesurés ecrans.ps1, en pixels physiques :
   « x:y:l:h:mmL:mmH », séparés par des points-virgules. */
const ECRANS = String(option(ARGV, "tel-ecrans", ""))
  .split(";")
  .map((s) => s.split(":").map(Number))
  .filter((v) => v.length === 6 && v.every(Number.isFinite))
  .map(([x, y, l, h, mmL, mmH]) => ({ x, y, l, h, mmL, mmH }));

/* La fenêtre de Claude, en pixels physiques : « x:y:l:h ». */
const CLAUDE = (() => {
  const v = String(option(ARGV, "tel-claude", "")).split(":").map(Number);
  return v.length === 4 && v.every(Number.isFinite) ? { x: v[0], y: v[1], width: v[2], height: v[3] } : null;
})();

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
   rouvre ceux qu'on avait fermés et suit la nouvelle adresse s'il y en a une.
   La seconde instance sort tout de suite : avec `app.quit()`, le moteur
   devenait prêt quand même et elle ouvrait deux téléphones de plus avant de
   partir. Constaté le 2026-10-01. */
const premiereInstance = app.requestSingleInstanceLock();
if (!premiereInstance) app.exit(0);

const telephones = new Map(); // id → { win, vue, ap, G, ecranId, teinte, etat }

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

/* ----------------------------- taille réelle ----------------------------- */

/** Pixels de fenêtre par millimètre, sur cet écran. Electron ne connaît pas la
    taille physique des écrans : elle vient de ecrans.ps1. On y retrouve
    l'écran par son origine et sa taille en pixels physiques. */
function mesure(d) {
  if (diagonale) {
    return { pxParMm: Math.hypot(d.size.width, d.size.height) / (diagonale * 25.4), source: "diagonale" };
  }
  const f = d.scaleFactor || 1;
  const l = Math.round(d.size.width * f);
  const h = Math.round(d.size.height * f);
  let origine = null;
  if (process.platform === "win32") {
    try {
      origine = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
    } catch {
      /* repli sur la taille seule */
    }
  }
  const memeTaille = ECRANS.filter((e) => Math.abs(e.l - l) <= 2 && Math.abs(e.h - h) <= 2);
  let e = origine ? memeTaille.find((m) => Math.abs(m.x - origine.x) <= 2 && Math.abs(m.y - origine.y) <= 2) : null;
  if (!e && memeTaille.length === 1) e = memeTaille[0];
  if (e && e.mmL > 0 && e.mmH > 0) {
    const a = d.size.width / e.mmL;
    const b = d.size.height / e.mmH;
    // Un téléviseur ou un vidéoprojecteur annonce parfois n'importe quoi : on
    // n'accepte qu'une mesure cohérente dans les deux sens.
    if (a > 1.2 && a < 15 && Math.abs(a - b) / a < 0.08) return { pxParMm: (a + b) / 2, source: "ecran" };
  }
  return { pxParMm: PX_PAR_MM_DEFAUT, source: "defaut" };
}

/** Millimètres par point de ce téléphone : le boîtier mesuré par Apple, rapporté
    au boîtier en points de la fiche. 0,166 pour les deux modèles. */
function mmParPoint(ap) {
  const l = ap.ecran.l + 2 * ap.bordure;
  const h = ap.ecran.h + 2 * ap.bordure;
  return (ap.boitierMm.l / l + ap.boitierMm.h / h) / 2;
}

/** L'échelle d'un téléphone posé sur cet écran : pixels de fenêtre par point. */
function echelleSur(ap, d) {
  const m = mesure(d);
  const reelle = mmParPoint(ap) * m.pxParMm;
  let k = reelle * echelleDemandee;
  // Plus haut que l'écran, il se réduit, et le dit sous lui.
  const kMax = (d.workArea.height - 8 - MARGE.h - MARGE.b) / (ap.ecran.h + 2 * ap.bordure);
  const reduit = k > kMax;
  if (reduit) k = kMax;
  return { k, reelle, reduit, source: m.source, ecranId: d.id };
}

/* ------------------------------ géométrie -------------------------------- */

/** La page voit la taille de la vue divisée par le zoom, arrondie vers le bas :
    402 × 766 ne tombe juste que si les deux divisions tombent entre 402 et 403,
    et entre 766 et 767. On cherche donc une largeur et une hauteur entières, en
    pixels de fenêtre, et un zoom qui satisfasse les deux, au milieu de
    l'intervalle permis pour ne pas dépendre d'un arrondi. Sans ça, le Pro Max
    voyait 849 pixels de haut à la taille réelle : constaté le 2026-10-01. */
function calage(lCss, hCss, k0) {
  let meilleur = null;
  for (const dl of [0, -1, 1, -2, 2]) {
    for (const dh of [0, -1, 1, -2, 2]) {
      const l = Math.round(lCss * k0) + dl;
      const h = Math.round(hCss * k0) + dh;
      const bas = Math.max(l / (lCss + 1), h / (hCss + 1));
      const haut = Math.min(l / lCss, h / hCss);
      if (haut - bas < 1e-6) continue;
      const zoom = (bas + haut) / 2;
      if (!meilleur || Math.abs(zoom - k0) < Math.abs(meilleur.zoom - k0)) meilleur = { zoom, l, h };
    }
  }
  return meilleur || { zoom: k0, l: Math.round(lCss * k0), h: Math.ceil(hCss * k0) };
}

/** Tout en pixels de fenêtre. Une seule source de vérité : la page du boîtier
    et la vue du site se calent sur les mêmes nombres. L'échelle finale est le
    zoom trouvé par `calage`, à quelques millièmes de la taille réelle : chaque
    téléphone a donc la sienne. */
function geometrie(ap, e) {
  const fenetreCss = calage(ap.ecran.l, ap.ecran.h - ap.statut - ap.bas, e.k);
  const largeurEcran = fenetreCss.l;
  const k = fenetreCss.zoom;
  const p = (v) => Math.round(v * k);
  const b = ap.bordure;
  const lB = ap.ecran.l + 2 * b;
  const hB = ap.ecran.h + 2 * b;
  const boitier = { x: MARGE.g, y: MARGE.h, l: p(lB), h: p(hB), r: p(ap.rayonEcran + b) };
  const ecran = { x: MARGE.g + p(b), y: MARGE.h + p(b), l: largeurEcran, h: p(ap.ecran.h), r: p(ap.rayonEcran) };
  const vue = { x: ecran.x, y: MARGE.h + p(b + ap.statut), l: largeurEcran, h: fenetreCss.h };
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
    taille: { facteur: k / e.reelle, reduit: e.reduit, source: e.source },
    fen: { l: boitier.l + MARGE.g + MARGE.d, h: boitier.h + MARGE.h + MARGE.b },
    boitier,
    tranche: Math.max(1, p(ap.tranche)),
    ecran,
    vue,
    ile: { l: p(ap.ile.l), h: p(ap.ile.h), haut: p(ap.ile.haut) },
    boutons,
  };
}

/* --------------------------- fenêtre du site ----------------------------- */

/** La vue a la taille du téléphone à l'échelle ; le zoom trouvé par `calage`
    rend à la page sa fenêtre exacte en pixels CSS. Il se repose à chaque
    chargement, Chrome le rattachant à l'origine plutôt qu'à la vue. */
function caler(wc, G) {
  if (!wc.isDestroyed() && Math.abs(wc.getZoomFactor() - G.k) > 1e-7) wc.setZoomFactor(G.k);
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

/* Au-dessus des autres fenêtres, et y rester. Pas au niveau « floating » : sous
   Windows, Electron range ce niveau juste sous la barre des tâches, en se
   plaçant derrière elle dans l'ordre des fenêtres. Quand une capture d'écran
   déplace la barre, la fenêtre perd au passage son statut de premier plan et
   tombe derrière les autres. Constaté le 2026-10-01. Le niveau « pop-up-menu »
   est simplement au premier plan, sans cette manœuvre ; et si Windows retire
   quand même le statut, la veille le remet. */
function garderAuDessus(w) {
  if (!w.isDestroyed() && !w.isAlwaysOnTop()) w.setAlwaysOnTop(true, "pop-up-menu");
}

function creer(id, e, position) {
  const ap = { id, ...FICHE.appareils[id] };
  const G = geometrie(ap, e);
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
  // Le niveau se pose explicitement : `alwaysOnTop: true` à la création vaut
  // « floating », justement celui qu'on évite.
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.on("always-on-top-changed", (_e, auDessus) => {
    if (!auDessus) setTimeout(() => garderAuDessus(win), 200);
  });

  const vue = new WebContentsView({
    // Une session par téléphone : Chrome attache le zoom à l'adresse du site, et
    // deux téléphones d'échelles différentes sur la même adresse se le
    // disputeraient. Et deux vrais téléphones n'ont pas les mêmes cookies.
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      zoomFactor: G.k,
      partition: "overlay-telephone-" + id,
    },
  });
  vue.setBackgroundColor("#ffffff");
  win.contentView.addChildView(vue);
  vue.setBounds({ x: G.vue.x, y: G.vue.y, width: G.vue.l, height: G.vue.h });

  const t = { win, vue, ap, G, ecranId: e.ecranId, teinte: null, etat: null };
  telephones.set(id, t);

  win.loadFile(path.join(ICI, "telephone.html"), {
    query: { g: JSON.stringify(G), domaine },
  });
  win.once("ready-to-show", () => win.showInactive());
  // Le nom du modèle dans la barre des tâches, pas le titre de la page du boîtier.
  win.on("page-title-updated", (ev) => ev.preventDefault());
  win.on("moved", ecrirePositions);
  win.on("closed", () => {
    telephones.delete(id);
  });

  // Le zoom se lit dans t.G, pas dans G : il change quand le téléphone passe
  // sur un écran d'une autre densité.
  const wc = vue.webContents;
  // Le nom du téléphone à la fin de l'agent : le serveur d'overlay sert ainsi à
  // chacun, une seule fois, la réponse d'un envoi fait dans la fenêtre principale.
  wc.setUserAgent(FICHE.agentUtilisateur + " " + id);
  wc.on("dom-ready", () => {
    caler(wc, t.G);
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
    caler(wc, t.G);
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

/** Redessine un téléphone posé sur un écran d'une autre densité : sa taille en
    millimètres ne doit pas changer d'un écran à l'autre. Le coin haut droit,
    où se tient la poignée, reste sous la souris. */
function rechausser(t) {
  if (t.win.isDestroyed()) return;
  const b = t.win.getBounds();
  const d = screen.getDisplayMatching(b);
  const G = geometrie(t.ap, echelleSur(t.ap, d));
  if (G.k === t.G.k) {
    t.ecranId = d.id;
    return;
  }
  t.G = G;
  t.ecranId = d.id;
  t.win.setResizable(true);
  t.win.setBounds({ x: b.x + b.width - G.fen.l, y: b.y, width: G.fen.l, height: G.fen.h });
  t.win.setResizable(false);
  t.vue.setBounds({ x: G.vue.x, y: G.vue.y, width: G.vue.l, height: G.vue.h });
  caler(t.vue.webContents, G);
  t.win.webContents.send("geometrie", G);
  log(t.ap.id, `autre écran : ${G.k.toFixed(4)} pixel par point, ${G.taille.source}`);
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

/* ------------------------------- placement ------------------------------- */

/** Où poser les téléphones la première fois : à côté de la fenêtre de Claude,
    sur le premier écran où ils tiennent sans la couvrir, à la hauteur de son
    milieu. Sinon, sur le bord gauche de son écran, par-dessus la liste des
    sessions plutôt que sur la fenêtre du site. On les déplace ensuite où l'on
    veut, et la place est retenue. */
function placementsParDefaut(ids) {
  const ecrans = screen.getAllDisplays();
  let claude = null;
  if (CLAUDE && process.platform === "win32") {
    try {
      claude = screen.screenToDipRect(null, CLAUDE);
    } catch {
      claude = null;
    }
  }
  const depart = claude ? screen.getDisplayMatching(claude) : screen.getPrimaryDisplay();
  const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const c0 = centre(depart.bounds);
  const distance = (d) => Math.hypot(centre(d.bounds).x - c0.x, centre(d.bounds).y - c0.y);
  const ordre = [depart, ...ecrans.filter((d) => d.id !== depart.id).sort((a, b) => distance(a) - distance(b))];
  const ESPACE = 14;

  const poser = (d, cote) => {
    const geos = ids.map((id) => {
      const ap = { id, ...FICHE.appareils[id] };
      return geometrie(ap, echelleSur(ap, d));
    });
    const largeur = geos.reduce((s, G) => s + G.fen.l, 0);
    const Z = d.workArea;
    let x;
    if (cote === "droite") x = Math.max(Z.x + ESPACE, claude.x + claude.width + ESPACE);
    else if (cote === "gauche") x = Math.min(Z.x + Z.width - ESPACE - largeur, claude.x - ESPACE - largeur);
    else x = Z.x + ESPACE;
    if (x < Z.x || x + largeur > Z.x + Z.width) return null;
    const milieu = claude ? claude.y + claude.height / 2 : Z.y + Z.height / 2;
    return geos.map((G) => {
      const y = Math.round(Math.min(Math.max(milieu - G.fen.h / 2, Z.y), Z.y + Z.height - G.fen.h));
      const pos = { x, y };
      x += G.fen.l;
      return pos;
    });
  };

  if (claude) {
    for (const d of ordre) {
      for (const cote of ["droite", "gauche"]) {
        const p = poser(d, cote);
        if (p) return p;
      }
    }
  }
  return poser(depart, "bord");
}

function ouvrirTout() {
  const ids = listeAppareils.filter((id) => !telephones.has(id));
  if (ids.length === 0) return;
  const memo = lirePositions();
  const defauts = placementsParDefaut(listeAppareils);
  for (const id of ids) {
    const ap = { id, ...FICHE.appareils[id] };
    let pos = defauts[listeAppareils.indexOf(id)];
    const m = memo[id];
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      const G = geometrie(ap, echelleSur(ap, screen.getDisplayNearestPoint({ x: m.x, y: m.y })));
      if (visible({ x: m.x, y: m.y, width: G.fen.l, height: G.fen.h })) pos = m;
    }
    const e = echelleSur(ap, screen.getDisplayNearestPoint({ x: pos.x + 100, y: pos.y + 100 }));
    creer(id, e, pos);
    log(id, `${e.k.toFixed(4)} pixel par point (${e.source}), en ${pos.x}, ${pos.y}`);
  }
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

/* -------------------------------- glisser -------------------------------- */

/* La poignée déplace le téléphone sans la zone de glisser de Windows
   (`-webkit-app-region: drag`). Celle-ci ne reçoit pas le survol : arrivée sur
   la poignée depuis la marge transparente, la souris laissait la fenêtre en
   mode « les clics traversent », et le clic tombait sur la fenêtre du dessous.
   Constaté le 2026-10-01. Ici la page signale le début, chaque mouvement et la
   fin ; la position vient du curseur lui-même, lu par le moteur. Une fin
   perdue ne fait pas courir le téléphone : sans mouvement signalé, il ne
   bouge pas. */
const glissements = new Map(); // id du contenu → { x, y, curseur }
ipcMain.on("glisser-debut", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  const [x, y] = w.getPosition();
  glissements.set(e.sender.id, { x, y, curseur: screen.getCursorScreenPoint() });
});
ipcMain.on("glisser", (e) => {
  const g = glissements.get(e.sender.id);
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!g || !w || w.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  w.setPosition(g.x + c.x - g.curseur.x, g.y + c.y - g.curseur.y);
});
ipcMain.on("glisser-fin", (e) => {
  if (!glissements.delete(e.sender.id)) return;
  const w = BrowserWindow.fromWebContents(e.sender);
  const t = [...telephones.values()].find((v) => v.win === w);
  if (t) rechausser(t);
  ecrirePositions();
});

/* --------------------------------- vie ----------------------------------- */

ipcMain.on("fermer", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
});
ipcMain.on("traverser", (e, v) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!!v, { forward: true });
});

function annonce() {
  const tailles = [...telephones.values()].map((t) => t.G.taille);
  const source = tailles.some((s) => s.source === "defaut")
    ? "taille estimée, l'écran n'a pas pu être mesuré : --diagonale <pouces> pour la régler"
    : tailles.some((s) => s.reduit)
      ? "réduits pour tenir dans la hauteur de l'écran"
      : echelleDemandee === 1
        ? "à la taille réelle"
        : `à ${String(echelleDemandee).replace(".", ",")} fois la taille réelle`;
  return "[telephones] prêts : " + listeAppareils.map((id) => FICHE.appareils[id].nom).join(" et ") + ", " + source;
}

if (premiereInstance) {
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
    console.log(annonce());
    setInterval(() => {
      for (const t of telephones.values()) sonder(t);
    }, 1500);
    setInterval(() => {
      for (const t of telephones.values()) garderAuDessus(t.win);
    }, 1000);
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
}
