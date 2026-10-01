#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Ouvre les deux iPhones flottants qui suivent la fenêtre de l'overlay.

       node telephones.mjs --url http://localhost:4400
       node telephones.mjs --url http://localhost:4400 --appareils max
       node telephones.mjs --installer           (installe le moteur, sans rien ouvrir)

   Les téléphones sont de vraies fenêtres, transparentes et sans cadre : on ne
   voit que l'appareil, qui flotte sur le bureau, au-dessus des autres fenêtres,
   à la taille d'un vrai iPhone. Chacun affiche le site à travers le serveur
   d'overlay, avec la fenêtre exacte du téléphone, et suit la fenêtre
   principale : défilement, page, rechargement.

   Sous Windows, ecrans.ps1 mesure d'abord la taille physique des écrans et la
   place de la fenêtre de Claude : c'est ce qui donne la taille réelle, et ce
   qui pose les téléphones à côté de Claude plutôt que dessus.

   Le moteur est Electron. Il s'installe une seule fois, hors du skill, dans
   ~/.claude/overlay/moteur (environ 120 Mo à télécharger, 370 Mo sur disque),
   pour qu'une mise à jour du skill ne l'efface pas.

   Le processus reste au premier plan tant que les téléphones sont ouverts :
   lance-le en arrière-plan. Fermer les deux téléphones le termine.

   Options transmises au moteur :
     --appareils standard,max   lesquels ouvrir (défaut : les deux)
     --echelle 1.5              multiple de la taille réelle (défaut : 1, réduite si l'écran est trop bas)
     --diagonale 27             diagonale de l'écran en pouces, si la mesure manque ou se trompe
     --journal                  écrire défilements et chargements sur la sortie
     --capture <dossier>        enregistrer une capture de chaque téléphone après 4 s
     --quitter                  quitter après la capture
--------------------------------------------------------------------------- */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DONNEES = process.env.OVERLAY_DATA || path.join(os.homedir(), ".claude", "overlay");
const MOTEUR = path.join(DONNEES, "moteur");
const VERSION = "44.5.1";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf("--" + n);
  if (i < 0) return d;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};

/* ------------------------------- moteur ---------------------------------- */

function binaire() {
  const dossier = path.join(MOTEUR, "node_modules", "electron");
  try {
    const relatif = readFileSync(path.join(dossier, "path.txt"), "utf8").trim();
    const absolu = path.join(dossier, "dist", relatif);
    return existsSync(absolu) ? absolu : null;
  } catch {
    return null;
  }
}

function installer() {
  console.log(`[telephones] Installation du moteur des téléphones (Electron ${VERSION}), une seule fois.`);
  console.log("[telephones] Environ 120 Mo à télécharger, dans " + MOTEUR);
  mkdirSync(MOTEUR, { recursive: true });
  const pkg = path.join(MOTEUR, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(
      pkg,
      JSON.stringify(
        {
          name: "overlay-telephones-moteur",
          private: true,
          description: "Moteur des téléphones flottants de /overlay. Installé une fois, hors du dépôt du skill.",
          dependencies: { electron: VERSION },
        },
        null,
        2,
      ),
    );
  }
  const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: MOTEUR, stdio: "inherit", shell: true });
  if (npm.status !== 0) {
    console.error("[telephones] npm install a échoué : vérifie la connexion, puis relance.");
    process.exit(1);
  }
  // npm 11 bloque les scripts d'installation : celui d'Electron, qui télécharge
  // le binaire, ne s'exécute donc pas. On le lance nous-mêmes.
  if (!binaire()) {
    const script = path.join(MOTEUR, "node_modules", "electron", "install.js");
    const r = spawnSync(process.execPath, [script], { cwd: MOTEUR, stdio: "inherit" });
    if (r.status !== 0 || !binaire()) {
      console.error("[telephones] Le binaire d'Electron n'a pas pu être téléchargé.");
      process.exit(1);
    }
  }
  console.log("[telephones] Moteur prêt.");
}

let exe = binaire();
if (!exe) {
  installer();
  exe = binaire();
}
if (opt("installer")) process.exit(0);

/* ------------------------------- lancement ------------------------------- */

const url = opt("url");
if (!url || url === true) {
  console.error("Usage : node telephones.mjs --url <OVERLAY_URL>   (la ligne OVERLAY_URL= du serveur d'overlay)");
  process.exit(1);
}

// Toujours `--nom=valeur` : un chemin Windows passé en argument séparé fait
// échouer le démarrage d'Electron, sans un message.
const passe = ["--tel-url=" + url];
const correspondances = {
  appareils: "tel-appareils",
  echelle: "tel-echelle",
  diagonale: "tel-diagonale",
  capture: "tel-capture",
  "capture-delai": "tel-capture-delai",
};
for (const [nom, cible] of Object.entries(correspondances)) {
  const v = opt(nom);
  if (v && v !== true) passe.push(`--${cible}=${v}`);
}
if (opt("journal")) passe.push("--tel-journal");
if (opt("quitter")) passe.push("--tel-quitter");

/* La taille physique des écrans et la fenêtre de Claude. Sans elles, les
   téléphones s'ouvrent quand même, à une taille estimée, et le disent. */
function mesurerEcrans() {
  if (process.platform !== "win32") return null;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ICI, "telephones", "ecrans.ps1")],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  try {
    return JSON.parse(String(r.stdout || "").trim().split(/\r?\n/).pop());
  } catch {
    return null;
  }
}
const mesures = mesurerEcrans();
if (mesures) {
  const ecrans = (mesures.ecrans || []).filter((e) => e && e.l > 0 && e.h > 0);
  if (ecrans.length) passe.push("--tel-ecrans=" + ecrans.map((e) => [e.x, e.y, e.l, e.h, e.mmL, e.mmH].join(":")).join(";"));
  const c = mesures.claude;
  if (c && c.l > 0 && c.h > 0) passe.push("--tel-claude=" + [c.x, c.y, c.l, c.h].join(":"));
  if (opt("journal")) {
    for (const e of ecrans) console.log(`[telephones] écran ${e.modele || "?"} : ${e.l} × ${e.h} px, ${e.mmL} × ${e.mmH} mm`);
  }
}

// L'application Claude est elle-même construite sur Electron : si cette variable
// a fuité dans l'environnement, notre binaire démarrerait comme un simple Node,
// sans fenêtre. On la retire.
const env = { ...process.env, OVERLAY_DATA: DONNEES };
delete env.ELECTRON_RUN_AS_NODE;

const enfant = spawn(exe, [path.join(ICI, "telephones", "main.cjs"), ...passe], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});

// Chromium écrit beaucoup sur stderr, avec un préfixe du type
// « [35388:1001/104759.003:ERROR:...] » : du bruit, sauf quand le moteur meurt.
// On ne relaie que nos propres lignes, et on garde le reste en réserve pour
// l'afficher si le moteur s'arrête sur une erreur.
const reserve = [];
const relayer = (flux, sortie) => {
  let reste = "";
  flux.on("data", (d) => {
    reste += d.toString("utf8");
    const lignes = reste.split(/\r?\n/);
    reste = lignes.pop();
    for (const l of lignes) {
      if (l.includes("[telephones]")) sortie.write(l + "\n");
      else if (l.trim()) {
        reserve.push(l);
        if (reserve.length > 40) reserve.shift();
      }
    }
  });
};
relayer(enfant.stdout, process.stdout);
relayer(enfant.stderr, process.stderr);

enfant.on("error", (e) => {
  console.error("[telephones] le moteur n'a pas pu démarrer : " + e.message);
  process.exit(1);
});
enfant.on("exit", (code) => {
  if (code) {
    console.error(`[telephones] le moteur s'est arrêté (code ${code}). Ses derniers messages :`);
    for (const l of reserve) console.error("  " + l);
  }
  console.log("[telephones] fermés.");
  process.exit(code ?? 0);
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => enfant.kill());
