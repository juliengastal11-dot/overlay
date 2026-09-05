/* ---------------------------------------------------------------------------
   Overlay d'édition visuelle — JavaScript pur, injecté par serveur-overlay.mjs.

   Survol = contour pointillé. Clic = sélection figée + bulle de commentaire.
   Entrée enregistre, une pastille numérotée reste sur l'élément — et se
   clique : le commentaire se rouvre, on le corrige ou on le retire. Les
   commentaires partent en lot (« Envoyer — N ») ou un par un (« Changement
   immédiat »). Après un envoi, une comète tourne autour de la barre tant que
   Claude n'a pas accusé réception. Alt+E bascule Navigation ⇄ Édition, Échap
   ferme.

   Sur écran tactile, il n'y a pas de survol : le doigt posé surligne, le
   relâchement sélectionne.

   Aucune dépendance, aucun framework : ce script doit fonctionner sur un site
   dont on ne sait rien. Tout son style est en ligne, isolé derrière
   `data-overlay-ui`, pour ne pas subir le CSS de la page ni le polluer.

   Portage du composant React de /buildyoursite. Si ce composant est déjà
   présent dans la page, on ne se monte pas : deux barres ne valent pas mieux
   qu'une.
--------------------------------------------------------------------------- */
(() => {
  if (window.__overlayMonte) return;
  if (document.querySelector("[data-buildyoursite-ui]")) return;
  window.__overlayMonte = true;

  /* -------------------------------- constantes ---------------------------- */

  const C = {
    bg: "#1f1e1d",
    bg2: "#2a2926",
    border: "#3d3b37",
    text: "#e9e6df",
    muted: "#8f8b82",
    accent: "#d97757",
  };
  const FONT = "ui-sans-serif, -apple-system, Segoe UI, system-ui, sans-serif";
  const CLE_MODE = "overlay:mode";
  const CLE_POS = "overlay:position";
  const LARGEUR_BULLE = 330;

  /* ---------------------------------- état -------------------------------- */

  const etat = {
    arme: false,
    survol: null,
    brouillon: null, // { cible, rect }
    message: "",
    fichiers: [], // { name, dataUrl }
    commentaires: [],
    enEdition: null, // numéro du commentaire rouvert depuis sa pastille
    immediat: false,
    envoi: false,
    flash: null,
    enAttente: false, // un lot est parti, Claude n'a pas encore accusé réception
    decalage: { x: 0, y: 0 },
    glisse: false,
  };
  let departGlisse = null;
  let minuterieFlash = null;
  let minuterieStatut = null;

  /* -------------------------------- helpers ------------------------------- */

  function cheminCss(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id) {
        parts.unshift("#" + node.id);
        break;
      }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const freres = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (freres.length > 1) sel += ":nth-of-type(" + (freres.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function decrire(el) {
    const cls = typeof el.className === "string" ? el.className : "";
    const src = el.closest && el.closest("[data-src]");
    return {
      selector: cheminCss(el),
      tag: el.tagName.toLowerCase(),
      classes: cls.slice(0, 300),
      text: ((el.innerText != null ? el.innerText : el.textContent) || "").trim().slice(0, 240),
      component: null,
      source: null,
      srcFile: src ? src.getAttribute("data-src") : null,
    };
  }

  function rectDoc(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height };
  }

  function estOverlay(el) {
    return !!(el && typeof el.closest === "function" && el.closest("[data-overlay-ui]"));
  }

  function estPoignee(cible) {
    return !!(cible && typeof cible.closest === "function") && !cible.closest("button, input, label, a, textarea, select");
  }

  function fichierVersDataUrl(f) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(f);
    });
  }

  function lireMemoire(cle) {
    try {
      return sessionStorage.getItem(cle);
    } catch {
      return null;
    }
  }
  function ecrireMemoire(cle, valeur) {
    try {
      sessionStorage.setItem(cle, valeur);
    } catch {
      /* sans mémoire : sans gravité */
    }
  }

  /** La zone de saisie grandit avec le texte, jusqu'à un plafond ; au-delà elle défile. */
  function ajusterHauteur(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }

  /** Crée un élément avec ses attributs et son style en ligne. */
  function el(tag, attrs, style, enfants) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    Object.assign(e.style, style || {});
    for (const c of enfants || []) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  /* ------------------------------ construction ---------------------------- */

  const racine = el("div", { "data-overlay-ui": "" }, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    zIndex: "2147483000",
    pointerEvents: "none",
    fontFamily: FONT,
  });

  // Isolement : les règles globales du site (button, input, textarea…) ne
  // doivent pas déformer l'overlay. La comète : un dégradé conique dont l'angle
  // tourne, posé derrière la barre, légèrement plus grand — la barre, opaque, ne
  // laisse voir qu'un anneau de trois pixels.
  const feuille = document.createElement("style");
  feuille.textContent =
    "[data-overlay-ui]{all:initial;position:absolute;top:0;left:0;width:100%;height:100%;z-index:2147483000;pointer-events:none;font-family:" +
    FONT +
    "}" +
    "[data-overlay-ui] *{box-sizing:border-box;font-family:inherit;line-height:1.35;letter-spacing:0;text-transform:none;text-shadow:none}" +
    "[data-overlay-ui] button{appearance:none;-webkit-appearance:none;margin:0}" +
    "[data-overlay-ui] textarea::placeholder{color:" + C.muted + "}" +
    "[data-overlay-ui] input[type=checkbox]{accent-color:" + C.accent + ";margin:0}" +
    "@property --ovl-angle{syntax:'<angle>';inherits:false;initial-value:0deg}" +
    "@keyframes ovl-comete{to{--ovl-angle:360deg}}" +
    "[data-overlay-ui] .ovl-comete{position:absolute;inset:-3px;border-radius:999px;pointer-events:none;" +
    "background:conic-gradient(from var(--ovl-angle),transparent 0deg,transparent 240deg,rgba(217,119,87,.12) 280deg," +
    C.accent + " 335deg,#ffd9c7 352deg,transparent 360deg);animation:ovl-comete 1.5s linear infinite}" +
    "@media (prefers-reduced-motion:reduce){[data-overlay-ui] .ovl-comete{animation:none;background:" + C.accent + ";opacity:.45}}";
  racine.appendChild(feuille);

  function boite(solide) {
    return el("div", {}, {
      position: "absolute",
      display: "none",
      outline: (solide ? "2px solid " : "2px dashed ") + C.accent,
      outlineOffset: "1px",
      borderRadius: "4px",
      background: solide ? "transparent" : C.accent + "14",
      pointerEvents: "none",
    });
  }
  const boiteSurvol = boite(false);
  const boiteBrouillon = boite(true);
  const couchePastilles = el("div", {}, { position: "absolute", top: "0", left: "0", pointerEvents: "none" });

  /* --- la bulle --- */
  const entete = el("span", {}, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
  const fermer = el("button", { type: "button", title: "Fermer (Échap)", text: "✕" }, {
    background: "none",
    border: "0",
    color: C.muted,
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: "1",
  });
  const zone = el("textarea", { rows: "2", placeholder: "Que veux-tu changer ici ?" }, {
    flex: "1",
    // Grandit avec le texte ; la poignée en bas à droite permet d'aller plus loin.
    resize: "vertical",
    minHeight: "58px",
    maxHeight: "40vh",
    overflow: "auto",
    background: C.bg2,
    border: "1px solid " + C.border,
    borderRadius: "8px",
    color: C.text,
    fontSize: "12.5px",
    lineHeight: "1.45",
    padding: "7px 9px",
    outline: "none",
    fontFamily: FONT,
    minWidth: "0",
  });
  const valider = el("button", { type: "button", title: "Enregistrer (Entrée)", text: "↵" }, {
    width: "30px",
    height: "30px",
    borderRadius: "8px",
    border: "0",
    fontSize: "14px",
    flex: "0 0 auto",
  });
  const joindre = el("button", { type: "button", title: "Joindre une image", text: "📎 Image" }, {
    background: C.bg2,
    border: "1px solid " + C.border,
    borderRadius: "7px",
    color: C.muted,
    cursor: "pointer",
    fontSize: "11px",
    padding: "3px 8px",
  });
  const champFichier = el("input", { type: "file", accept: "image/*", multiple: "" }, { display: "none" });
  const puces = el("div", {}, { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" });
  const supprimer = el("button", { type: "button", title: "Retirer ce commentaire du lot", text: "Supprimer" }, {
    marginLeft: "auto",
    background: "none",
    border: "1px solid " + C.border,
    borderRadius: "7px",
    color: C.muted,
    cursor: "pointer",
    fontSize: "11px",
    padding: "3px 8px",
    display: "none",
  });

  const bulle = el("div", {}, {
    position: "absolute",
    display: "none",
    width: LARGEUR_BULLE + "px",
    pointerEvents: "auto",
    background: C.bg,
    border: "1px solid " + C.border,
    borderRadius: "12px",
    boxShadow: "0 12px 40px rgba(0,0,0,.45)",
    padding: "10px",
    color: C.text,
  }, [
    el("div", {}, { fontSize: "10.5px", color: C.muted, marginBottom: "7px", display: "flex", justifyContent: "space-between", gap: "8px" }, [entete, fermer]),
    el("div", {}, { display: "flex", alignItems: "flex-end", gap: "6px" }, [zone, valider]),
    el("div", {}, { display: "flex", alignItems: "center", gap: "8px", marginTop: "7px", flexWrap: "wrap" }, [joindre, champFichier, puces, supprimer]),
  ]);

  /* --- la barre --- */
  const poignee = el("span", { "aria-hidden": "true" }, {
    display: "grid",
    gridTemplateColumns: "repeat(2, 2px)",
    gap: "2px",
    padding: "0 2px",
    opacity: "0.45",
  });
  for (let i = 0; i < 6; i++) poignee.appendChild(el("span", {}, { width: "2px", height: "2px", borderRadius: "999px", background: C.text }));

  function boutonMode(libelle, actif) {
    const b = el("button", { type: "button", role: "radio", title: "Alt+E pour basculer", text: libelle }, {
      border: "0",
      borderRadius: "999px",
      padding: "4px 11px",
      fontSize: "11.5px",
      cursor: "pointer",
      transition: "background .12s, color .12s",
    });
    b.addEventListener("click", () => {
      etat.arme = actif;
      ecrireMemoire(CLE_MODE, actif ? "edition" : "navigation");
      if (!actif) fermerBulle();
      rendre();
    });
    return b;
  }
  const btnNavigation = boutonMode("Navigation", false);
  const btnEdition = boutonMode("Édition", true);
  const groupeMode = el("div", { role: "radiogroup", "aria-label": "Mode de l'aperçu" }, {
    display: "flex",
    gap: "2px",
    background: C.bg2,
    borderRadius: "999px",
    padding: "2px",
  }, [btnNavigation, btnEdition]);

  const caseImmediat = el("input", { type: "checkbox" }, {});
  const etiquetteImmediat = el("label", { title: "Applique chaque commentaire dès sa validation, sans attendre un envoi groupé" }, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    cursor: "pointer",
    color: C.muted,
    fontSize: "11.5px",
  }, [caseImmediat, el("span", { text: "Changement immédiat" })]);

  const flash = el("span", {}, { color: C.accent, fontSize: "11.5px", display: "none" });
  const envoyer = el("button", { type: "button" }, {
    background: C.accent,
    border: "0",
    borderRadius: "999px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "11.5px",
    fontWeight: "600",
    padding: "5px 12px",
    display: "none",
  });

  const comete = el("div", { class: "ovl-comete", "aria-hidden": "true" }, { display: "none" });

  const barre = el("div", { title: "Glissez la barre par son fond pour la déplacer" }, {
    position: "relative",
    zIndex: "1",
    pointerEvents: "auto",
    background: C.bg,
    border: "1px solid " + C.border,
    borderRadius: "999px",
    boxShadow: "0 8px 28px rgba(0,0,0,.4)",
    padding: "6px 8px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    color: C.text,
    fontSize: "11.5px",
    cursor: "grab",
    touchAction: "none",
    userSelect: "none",
  }, [
    poignee,
    groupeMode,
    el("span", {}, { width: "1px", height: "15px", background: C.border }),
    etiquetteImmediat,
    flash,
    envoyer,
  ]);

  // La barre et sa comète voyagent ensemble : l'enveloppe porte l'ancrage et le déplacement.
  const enveloppeBarre = el("div", {}, { position: "fixed", right: "14px", bottom: "14px", pointerEvents: "none" }, [comete, barre]);

  racine.appendChild(boiteSurvol);
  racine.appendChild(boiteBrouillon);
  racine.appendChild(couchePastilles);
  racine.appendChild(bulle);
  racine.appendChild(enveloppeBarre);

  /* --------------------------------- rendu -------------------------------- */

  function placer(b, r) {
    b.style.display = "block";
    b.style.top = r.top + "px";
    b.style.left = r.left + "px";
    b.style.width = r.width + "px";
    b.style.height = r.height + "px";
  }

  function positionBulle(rect) {
    const w = LARGEUR_BULLE;
    const left = Math.min(Math.max(rect.left, window.scrollX + 8), window.scrollX + window.innerWidth - w - 8);
    const dessous = rect.top + rect.height + 10;
    const place = window.scrollY + window.innerHeight - dessous;
    const top = place > 220 ? dessous : Math.max(window.scrollY + 8, rect.top - 230);
    return { top, left };
  }

  function rendre() {
    if (etat.arme && etat.survol && !etat.brouillon) placer(boiteSurvol, etat.survol);
    else boiteSurvol.style.display = "none";
    if (etat.brouillon) placer(boiteBrouillon, etat.brouillon.rect);
    else boiteBrouillon.style.display = "none";

    // pastilles — cliquables : le commentaire se rouvre
    couchePastilles.replaceChildren(
      ...etat.commentaires.map((c) => {
        const p = el("button", { type: "button", title: c.message + " — cliquer pour modifier", text: String(c.n) }, {
          position: "absolute",
          top: c.rect.top - 10 + "px",
          left: c.rect.left - 10 + "px",
          width: "22px",
          height: "22px",
          borderRadius: "999px",
          border: etat.enEdition === c.n ? "2px solid #fff" : "0",
          padding: "0",
          background: C.accent,
          color: "#fff",
          fontSize: "12px",
          fontWeight: "600",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px rgba(0,0,0,.35)",
          pointerEvents: "auto",
          cursor: "pointer",
        });
        p.addEventListener("click", () => rouvrir(c));
        return p;
      }),
    );

    if (etat.brouillon) {
      const p = positionBulle(etat.brouillon.rect);
      bulle.style.display = "block";
      bulle.style.top = p.top + "px";
      bulle.style.left = p.left + "px";
      const t = etat.brouillon.cible;
      entete.textContent =
        (etat.enEdition !== null ? "Commentaire " + etat.enEdition + " · " : "") +
        (t.component || t.tag) +
        (t.text ? " · " + t.text.slice(0, 34) : "");
      const ok = etat.message.trim().length > 0;
      valider.style.background = ok ? C.accent : C.bg2;
      valider.style.color = ok ? "#fff" : C.muted;
      valider.style.cursor = ok ? "pointer" : "default";
      valider.disabled = !ok;
      supprimer.style.display = etat.enEdition !== null ? "inline-block" : "none";
      puces.replaceChildren(
        ...etat.fichiers.map((f, i) => {
          const puce = el("span", { title: "Retirer", text: f.name + " ✕" }, {
            fontSize: "10px",
            color: C.text,
            background: C.bg2,
            border: "1px solid " + C.border,
            borderRadius: "6px",
            padding: "2px 6px",
            cursor: "pointer",
            maxWidth: "92px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          });
          puce.addEventListener("click", () => {
            etat.fichiers = etat.fichiers.filter((_, j) => j !== i);
            rendre();
          });
          return puce;
        }),
      );
    } else {
      bulle.style.display = "none";
    }

    for (const [b, actif] of [[btnNavigation, false], [btnEdition, true]]) {
      const choisi = etat.arme === actif;
      b.setAttribute("aria-checked", String(choisi));
      b.style.fontWeight = choisi ? "600" : "500";
      b.style.background = choisi ? (actif ? C.accent : C.border) : "transparent";
      b.style.color = choisi ? (actif ? "#fff" : C.text) : C.muted;
    }
    caseImmediat.checked = etat.immediat;
    const texteBarre = etat.enAttente ? "Envoyé · Claude arrive…" : etat.flash;
    flash.style.display = texteBarre ? "inline" : "none";
    flash.textContent = texteBarre || "";
    comete.style.display = etat.enAttente ? "block" : "none";
    envoyer.style.display = etat.commentaires.length > 0 ? "inline-block" : "none";
    envoyer.textContent = etat.envoi ? "Envoi…" : "Envoyer — " + etat.commentaires.length;
    envoyer.disabled = etat.envoi;
    enveloppeBarre.style.transform = "translate(" + etat.decalage.x + "px, " + etat.decalage.y + "px)";
    barre.style.cursor = etat.glisse ? "grabbing" : "grab";
    barre.style.boxShadow = etat.glisse ? "0 14px 40px rgba(0,0,0,.55)" : "0 8px 28px rgba(0,0,0,.4)";
    document.body.style.cursor = etat.arme && !etat.brouillon ? "crosshair" : "";
  }

  /* -------------------------------- actions ------------------------------- */

  function afficherFlash(texte) {
    etat.flash = texte;
    rendre();
    clearTimeout(minuterieFlash);
    minuterieFlash = setTimeout(() => {
      etat.flash = null;
      rendre();
    }, 2500);
  }

  /* Tant qu'un lot est `pending`, on interroge le serveur toutes les 1,5 s.
     Claude passe le lot à `en_cours` dès son réveil : c'est ce qui arrête la
     comète. Au montage, on vérifie une fois — un lot envoyé depuis une autre
     page peut encore attendre. */
  async function verifierStatut() {
    try {
      const r = await fetch("/__overlay/statut", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const reste = (d.batches || []).some((b) => b.status === "pending");
      if (reste && !etat.enAttente) {
        etat.enAttente = true;
        rendre();
        surveillerStatut();
      } else if (!reste && etat.enAttente) {
        etat.enAttente = false;
        clearInterval(minuterieStatut);
        minuterieStatut = null;
        afficherFlash("Claude a pris la main");
      }
    } catch {
      /* serveur en train de redémarrer : on réessaie au prochain tour */
    }
  }
  function surveillerStatut() {
    if (minuterieStatut) return;
    minuterieStatut = setInterval(verifierStatut, 1500);
  }

  async function ajouterFichiers(liste) {
    if (!liste) return;
    const images = Array.from(liste).filter((f) => f.type && f.type.startsWith("image/")).slice(0, 4);
    const lus = await Promise.all(images.map(async (f) => ({ name: f.name || "image.png", dataUrl: await fichierVersDataUrl(f) })));
    etat.fichiers = etat.fichiers.concat(lus).slice(0, 4);
    rendre();
  }

  async function poster(lot) {
    etat.envoi = true;
    rendre();
    try {
      const r = await fetch("/__overlay/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: location.pathname,
          comments: lot.map((c) => ({ n: c.n, message: c.message, target: c.cible, attachments: c.fichiers })),
        }),
      });
      if (!r.ok) throw new Error(String(r.status));
      etat.commentaires = [];
      etat.flash = null;
      etat.enAttente = true;
      surveillerStatut();
    } catch {
      afficherFlash("Échec de l'envoi");
    } finally {
      etat.envoi = false;
      rendre();
    }
  }

  function fermerBulle() {
    etat.brouillon = null;
    etat.enEdition = null;
    etat.survol = null;
    etat.message = "";
    etat.fichiers = [];
    zone.value = "";
    rendre();
  }

  /** Rouvre un commentaire depuis sa pastille, texte et images en place. */
  function rouvrir(c) {
    etat.brouillon = { cible: c.cible, rect: c.rect };
    etat.message = c.message;
    etat.fichiers = c.fichiers;
    etat.enEdition = c.n;
    etat.survol = null;
    zone.value = c.message;
    rendre();
    setTimeout(() => {
      zone.focus();
      ajusterHauteur(zone);
    }, 20);
  }

  function validerBrouillon() {
    if (!etat.brouillon || !etat.message.trim()) return;
    if (etat.enEdition !== null) {
      const n = etat.enEdition;
      etat.commentaires = etat.commentaires.map((c) =>
        c.n === n ? Object.assign({}, c, { message: etat.message.trim(), fichiers: etat.fichiers }) : c,
      );
      fermerBulle();
      return;
    }
    const c = {
      n: etat.commentaires.length + 1,
      message: etat.message.trim(),
      cible: etat.brouillon.cible,
      rect: etat.brouillon.rect,
      fichiers: etat.fichiers,
    };
    fermerBulle();
    if (etat.immediat) poster([c]);
    else {
      etat.commentaires.push(c);
      rendre();
    }
  }

  /** Retire le commentaire rouvert et renumérote les suivants. */
  function supprimerCommentaire() {
    if (etat.enEdition === null) return;
    const n = etat.enEdition;
    etat.commentaires = etat.commentaires.filter((c) => c.n !== n).map((c, i) => Object.assign({}, c, { n: i + 1 }));
    fermerBulle();
  }

  /* ------------------------------- événements ----------------------------- */

  fermer.addEventListener("click", fermerBulle);
  valider.addEventListener("click", validerBrouillon);
  supprimer.addEventListener("click", supprimerCommentaire);
  joindre.addEventListener("click", () => champFichier.click());
  champFichier.addEventListener("change", () => {
    ajouterFichiers(champFichier.files);
    champFichier.value = "";
  });
  zone.addEventListener("input", () => {
    etat.message = zone.value;
    ajusterHauteur(zone);
    rendre();
  });
  zone.addEventListener("paste", (e) => {
    const images = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith("image/"));
    if (images.length) {
      e.preventDefault();
      ajouterFichiers(images);
    }
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      validerBrouillon();
    }
    if (e.key === "Escape") fermerBulle();
    // Les raccourcis du site ne doivent pas se déclencher pendant qu'on écrit.
    e.stopPropagation();
  });
  caseImmediat.addEventListener("change", () => {
    etat.immediat = caseImmediat.checked;
    rendre();
  });
  envoyer.addEventListener("click", () => poster(etat.commentaires));

  // Déplacement de la barre par son fond. Décalage en `transform` depuis son
  // ancrage bas-droite : déplacer en left/top recalculerait la mise en page à
  // chaque pixel.
  barre.addEventListener("pointerdown", (e) => {
    if (!estPoignee(e.target)) return;
    e.preventDefault();
    barre.setPointerCapture(e.pointerId);
    departGlisse = { px: e.clientX, py: e.clientY, ox: etat.decalage.x, oy: etat.decalage.y };
    etat.glisse = true;
    rendre();
  });
  barre.addEventListener("pointermove", (e) => {
    if (!departGlisse) return;
    const marge = 8;
    const r = barre.getBoundingClientRect();
    const xMin = -(window.innerWidth - r.width - marge * 2);
    const yMin = -(window.innerHeight - r.height - marge * 2);
    etat.decalage = {
      x: Math.min(0, Math.max(xMin, departGlisse.ox + (e.clientX - departGlisse.px))),
      y: Math.min(0, Math.max(yMin, departGlisse.oy + (e.clientY - departGlisse.py))),
    };
    rendre();
  });
  const finGlisse = (e) => {
    if (!departGlisse) return;
    departGlisse = null;
    etat.glisse = false;
    try {
      barre.releasePointerCapture(e.pointerId);
    } catch {
      /* déjà relâché */
    }
    ecrireMemoire(CLE_POS, JSON.stringify(etat.decalage));
    rendre();
  };
  barre.addEventListener("pointerup", finGlisse);
  barre.addEventListener("pointercancel", finGlisse);

  // Capture sur le document : en Édition, le site ne reçoit pas les clics.
  const surligner = (cible) => {
    if (!etat.arme || etat.brouillon) return;
    etat.survol = !cible || estOverlay(cible) ? null : rectDoc(cible);
    rendre();
  };
  document.addEventListener("mousemove", (e) => surligner(e.target), true);
  // Tactile : pas de survol possible. Le doigt posé surligne, le relâchement
  // (le clic qui suit) sélectionne. Même geste, réactif.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse") return;
      surligner(e.target);
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (!etat.arme) return;
      const t = e.target;
      if (!t || estOverlay(t)) return;
      e.preventDefault();
      e.stopPropagation();
      etat.brouillon = { cible: decrire(t), rect: rectDoc(t) };
      etat.enEdition = null;
      etat.message = "";
      etat.fichiers = [];
      zone.value = "";
      etat.survol = null;
      rendre();
      setTimeout(() => {
        zone.focus();
        ajusterHauteur(zone);
      }, 20);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") fermerBulle();
      if (e.altKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        etat.arme = !etat.arme;
        ecrireMemoire(CLE_MODE, etat.arme ? "edition" : "navigation");
        if (!etat.arme) fermerBulle();
        rendre();
      }
    },
    true,
  );

  /* -------------------------------- montage ------------------------------- */

  function monter() {
    if (lireMemoire(CLE_MODE) === "edition") etat.arme = true;
    try {
      const p = JSON.parse(lireMemoire(CLE_POS) || "null");
      if (p && typeof p.x === "number" && typeof p.y === "number") etat.decalage = p;
    } catch {
      /* position illisible : coin bas-droite */
    }
    document.body.appendChild(racine);
    rendre();
    verifierStatut();
  }

  if (document.body) monter();
  else document.addEventListener("DOMContentLoaded", monter);
})();
