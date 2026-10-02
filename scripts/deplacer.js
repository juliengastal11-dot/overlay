/* ---------------------------------------------------------------------------
   Déplacer à la souris : module de /overlay, JavaScript pur, injecté par
   serveur-overlay.mjs à côté de l'overlay. Il sert aussi les projets
   /buildyoursite, dont il ne modifie pas l'overlay.

   En mode Édition, un clic sélectionne un élément (l'overlay ouvre sa bulle de
   commentaire comme avant). Ce module ajoute, sur le côté de l'élément :

   - une croix directionnelle : on glisse le pion central, ou on clique une
     flèche (Maj : dix pixels). L'élément suit en direct, par la propriété CSS
     `translate`, la seule chose écrite dans la page, et réversible ;
   - une rangée de petits points, comme les boutons d'une fenêtre : un point par
     voisin de l'élément, le point allumé est sa position, un clic sur un autre
     point l'y place (aperçu par `order` en flex et grid, par décalages en pile).

   Rien n'est écrit dans le code tant qu'on n'a pas cliqué « Envoyer » : le lot
   part comme un commentaire, avec `target.deplacement` pour les valeurs. Quand
   Claude passe le lot à `done`, l'aperçu s'efface et laisse voir son code.

   Le mode Édition se lit sur les boutons Navigation / Édition de l'overlay
   (`role="radio"`, `aria-checked`), identiques dans overlay.js et dans le
   composant React : aucune modification de l'hôte, donc rien à mettre à jour
   dans un projet existant.
--------------------------------------------------------------------------- */
(() => {
  if (window.__overlayDeplacer) return;
  window.__overlayDeplacer = true;

  const C = {
    bg: "#1f1e1d",
    bg2: "#2a2926",
    border: "#3d3b37",
    text: "#e9e6df",
    muted: "#8f8b82",
    accent: "#d97757",
    cible: "#4da3ff",
  };
  const FONT = "ui-sans-serif, -apple-system, Segoe UI, system-ui, sans-serif";
  const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const UI = "[data-overlay-ui],[data-buildyoursite-ui]";
  const ATOMES = "button,a[href],[role='button'],input,select,textarea,img,svg,video,canvas,label,summary";
  const IGNORES = /^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT|META)$/;
  const MAX_POINTS = 8;
  const LARGEUR_PANNEAU = 244;

  const etat = {
    arme: false,
    cible: null, // l'élément sélectionné
    modifs: new Map(), // élément -> enregistrement
    gardes: [], // enregistrements d'un lot envoyé, aperçu gardé jusqu'à `done`
    envoye: null, // { avant, id, statut, depuis }
    drag: null,
    flash: null,
    ancre: null, // où l'élément était à sa sélection : le panneau s'y pose et n'en bouge plus
    decPanneau: { x: 0, y: 0 }, // le panneau, déplacé à la main par son titre
    dragPanneau: null,
  };
  let ui = null;
  let minuterieStatut = null;
  let minuterieFlash = null;
  let boucleActive = false;
  let dernierRect = "";

  /* -------------------------------- helpers ------------------------------- */

  function noeud(tag, attrs, style, enfants) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    e.style.boxSizing = "border-box";
    Object.assign(e.style, style || {});
    for (const c of enfants || []) e.appendChild(c);
    return e;
  }

  const estUI = (n) => !!(n && n.closest && n.closest(UI));
  const ordinal = (n) => (n === 1 ? "1er" : n + "e");
  const signe = (n) => (n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0");

  function nomCourt(e) {
    const brut = typeof e.innerText === "string" ? e.innerText : e.textContent || "";
    const t = brut.trim().replace(/\s+/g, " ").slice(0, 26);
    return e.tagName.toLowerCase() + (t ? " « " + t + " »" : "");
  }

  function cheminCss(e) {
    const parts = [];
    let node = e;
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

  /** Même description que l'overlay : le watcher retrouve le code de la même façon. */
  function decrire(e) {
    const cls = typeof e.className === "string" ? e.className : "";
    const src = e.closest && e.closest("[data-src]");
    return {
      selector: cheminCss(e),
      tag: e.tagName.toLowerCase(),
      classes: cls.slice(0, 300),
      text: ((e.innerText != null ? e.innerText : e.textContent) || "").trim().slice(0, 240),
      component: null,
      source: null,
      srcFile: src ? src.getAttribute("data-src") : null,
    };
  }

  /** Les voisins de l'élément qui participent à la mise en page, dans l'ordre du code. */
  function freresDe(e) {
    const p = e.parentElement;
    if (!p) return [];
    return Array.from(p.children).filter((c) => {
      if (IGNORES.test(c.tagName) || estUI(c)) return false;
      const s = getComputedStyle(c);
      return s.display !== "none" && s.position !== "absolute" && s.position !== "fixed";
    });
  }

  function lireTranslate(e) {
    const v = getComputedStyle(e).translate;
    if (!v || v === "none") return { x: 0, y: 0 };
    const p = v.split(/\s+/).map(parseFloat);
    return { x: p[0] || 0, y: p[1] || 0 };
  }

  /* ----------------------- enregistrements et aperçu ----------------------- */

  function rec(e) {
    let m = etat.modifs.get(e);
    if (!m) {
      const base = lireTranslate(e);
      m = {
        e,
        base,
        x: base.x,
        y: base.y,
        decX: 0,
        decY: 0,
        ordre: null, // { de, vers, sur }, indices à partir de 0
        sansApercu: false,
        etaitInline: false,
        utilisateur: false, // touché par l'utilisateur : part dans le lot
        inline: { translate: e.style.translate, order: e.style.order, display: e.style.display },
      };
      etat.modifs.set(e, m);
    }
    return m;
  }

  function pose(m) {
    m.e.style.translate = m.x + m.decX + "px " + (m.y + m.decY) + "px";
  }
  function synchroniser(m) {
    if (m.decX || m.decY || m.x !== m.base.x || m.y !== m.base.y) pose(m);
    else m.e.style.translate = m.inline.translate;
  }
  function rendre(m) {
    m.e.style.translate = m.inline.translate;
    m.e.style.order = m.inline.order;
    m.e.style.display = m.inline.display;
  }

  /** Une translation n'a pas d'effet sur un élément `inline` : on le passe en inline-block pour l'aperçu. */
  function assurerTranslatable(m) {
    if (getComputedStyle(m.e).display === "inline") {
      m.e.style.display = "inline-block";
      m.etaitInline = true;
    }
  }

  const dTr = (m) => ({ dx: Math.round(m.x - m.base.x), dy: Math.round(m.y - m.base.y) });
  const aChange = (m) => m.utilisateur && (!!m.ordre || dTr(m).dx !== 0 || dTr(m).dy !== 0);
  const nbChanges = () => Array.from(etat.modifs.values()).filter(aChange).length;

  function detecterAxe(liste) {
    if (liste.length < 2) return null;
    const hauts = liste.map((f) => f.offsetTop);
    if (hauts.every((v) => Math.abs(v - hauts[0]) <= 2)) return "x";
    for (let i = 1; i < liste.length; i++) if (hauts[i] < hauts[i - 1] + liste[i - 1].offsetHeight - 2) return null;
    return "y";
  }

  /** Remet les voisins à zéro puis applique le nouvel ordre : `order` en flex/grid, décalages en pile. */
  function appliquerOrdre(liste, e, de, vers) {
    for (const f of liste) {
      const mf = etat.modifs.get(f);
      if (!mf) continue;
      mf.decX = 0;
      mf.decY = 0;
      f.style.order = mf.inline.order;
      synchroniser(mf);
    }
    const m = rec(e);
    m.sansApercu = false;
    if (de === vers) return;
    const nouvel = liste.slice();
    nouvel.splice(de, 1);
    nouvel.splice(vers, 0, e);
    const parent = e.parentElement;
    if (/flex|grid/.test(getComputedStyle(parent).display)) {
      nouvel.forEach((f, i) => {
        rec(f);
        f.style.order = String(i);
      });
      return;
    }
    const axe = detecterAxe(liste);
    if (!axe || liste.some((f) => getComputedStyle(f).display === "inline")) {
      m.sansApercu = true;
      return;
    }
    const pos = axe === "y" ? (f) => f.offsetTop : (f) => f.offsetLeft;
    const taille = axe === "y" ? (f) => f.offsetHeight : (f) => f.offsetWidth;
    const ecarts = [];
    for (let i = 0; i < liste.length - 1; i++) ecarts.push(pos(liste[i + 1]) - (pos(liste[i]) + taille(liste[i])));
    let curseur = pos(liste[0]);
    nouvel.forEach((f, i) => {
      const dec = curseur - pos(f);
      curseur += taille(f) + (ecarts[i] || 0);
      const mf = rec(f);
      if (axe === "y") {
        mf.decX = 0;
        mf.decY = dec;
      } else {
        mf.decX = dec;
        mf.decY = 0;
      }
      synchroniser(mf);
    });
  }

  function definirOrdre(e, vers) {
    const liste = freresDe(e);
    const de = liste.indexOf(e);
    if (de < 0 || vers < 0 || vers >= liste.length) return;
    const m = rec(e);
    m.utilisateur = true;
    m.ordre = vers === de ? null : { de, vers, sur: liste.length };
    appliquerOrdre(liste, e, de, vers);
    maj();
  }

  function pousser(dx, dy) {
    if (!etat.cible || etat.envoye) return;
    const m = rec(etat.cible);
    m.utilisateur = true;
    assurerTranslatable(m);
    m.x += dx;
    m.y += dy;
    pose(m);
    maj();
  }

  function remettre() {
    const m = etat.cible && etat.modifs.get(etat.cible);
    if (!m || etat.envoye) return;
    m.x = m.base.x;
    m.y = m.base.y;
    const liste = freresDe(m.e);
    const i = liste.indexOf(m.e);
    if (i >= 0) appliquerOrdre(liste, m.e, i, i);
    m.ordre = null;
    synchroniser(m);
    maj();
  }

  function toutAnnuler() {
    for (const m of etat.modifs.values()) rendre(m);
    etat.modifs = new Map();
    maj();
  }

  /* --------------------------------- lot ----------------------------------- */

  function phraseDecalage(dx, dy) {
    const p = [];
    if (dx !== 0) p.push(Math.abs(dx) + " px vers " + (dx > 0 ? "la droite" : "la gauche"));
    if (dy !== 0) p.push(Math.abs(dy) + " px vers " + (dy > 0 ? "le bas" : "le haut"));
    return p.join(" et de ");
  }

  function construireLot() {
    const sortie = [];
    let n = 0;
    for (const m of etat.modifs.values()) {
      if (!aChange(m)) continue;
      n++;
      const t = dTr(m);
      const liste = freresDe(m.e);
      const parent = m.e.parentElement;
      const cs = parent ? getComputedStyle(parent) : null;
      const dep = { type: "deplacement-souris" };
      const phrases = [];

      if (t.dx !== 0 || t.dy !== 0) {
        dep.translation = {
          dx: t.dx,
          dy: t.dy,
          unite: "px",
          depart: { x: Math.round(m.base.x), y: Math.round(m.base.y) },
          arrivee: { x: Math.round(m.x), y: Math.round(m.y) },
        };
        phrases.push("le décaler de " + phraseDecalage(t.dx, t.dy) + ", par translation, exactement comme dans l'aperçu");
      }
      if (m.ordre) {
        const nouvel = liste.slice();
        nouvel.splice(m.ordre.de, 1);
        nouvel.splice(m.ordre.vers, 0, m.e);
        const apres = nouvel[m.ordre.vers - 1] ? nomCourt(nouvel[m.ordre.vers - 1]) : null;
        const avant = nouvel[m.ordre.vers + 1] ? nomCourt(nouvel[m.ordre.vers + 1]) : null;
        dep.ordre = {
          de: m.ordre.de + 1,
          vers: m.ordre.vers + 1,
          sur: m.ordre.sur,
          apres,
          avant,
          freres: liste.map(nomCourt),
        };
        const place = !apres ? "tout au début, avant " + avant : !avant ? "tout à la fin, après " + apres : "entre " + apres + " et " + avant;
        phrases.push(
          "le placer en " + ordinal(m.ordre.vers + 1) + " position sur " + m.ordre.sur + " parmi ses voisins (il est " + ordinal(m.ordre.de + 1) + "), " + place,
        );
      }
      if (cs) {
        dep.conteneur = {
          selector: cheminCss(parent),
          tag: parent.tagName.toLowerCase(),
          display: cs.display,
          flexDirection: /flex/.test(cs.display) ? cs.flexDirection : null,
          gap: cs.gap && cs.gap !== "normal" ? cs.gap : null,
          enfants: liste.length,
        };
      }
      if (m.etaitInline) dep.element = { display: "inline", remarque: "une translation n'a pas d'effet sur un élément inline : il faut inline-block" };
      dep.fenetre = { largeur: window.innerWidth, hauteur: window.innerHeight };

      sortie.push({
        n,
        message: "[Déplacement à la souris] " + nomCourt(m.e) + " : " + phrases.join(" ; puis ") + ".",
        target: Object.assign(decrire(m.e), { deplacement: dep }),
        attachments: [],
      });
    }
    return sortie;
  }

  /** Les projets /buildyoursite reçoivent leurs lots sur leur route, les autres sites sur le serveur d'overlay. */
  function hote() {
    const react = !!document.querySelector("[data-buildyoursite-ui]:not([data-deplacer])");
    return react ? { poster: "/api/buildyoursite", statut: "/api/buildyoursite" } : { poster: "/__overlay/comments", statut: "/__overlay/statut" };
  }

  async function lireStatut() {
    try {
      const r = await fetch(hote().statut, { cache: "no-store" });
      if (!r.ok) return null;
      const d = await r.json();
      return Array.isArray(d.batches) ? d.batches : [];
    } catch {
      return null;
    }
  }

  function afficherFlash(texte) {
    etat.flash = texte;
    maj();
    clearTimeout(minuterieFlash);
    minuterieFlash = setTimeout(() => {
      etat.flash = null;
      maj();
    }, 2600);
  }

  async function envoyer() {
    if (etat.envoye) return;
    const comments = construireLot();
    if (!comments.length) return;
    const h = hote();
    const avant = new Set(((await lireStatut()) || []).map((b) => b.id));
    try {
      const r = await fetch(h.poster, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: location.pathname, comments }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      afficherFlash("Échec de l'envoi");
      return;
    }
    etat.gardes = Array.from(etat.modifs.values());
    etat.modifs = new Map();
    etat.envoye = { avant, id: null, statut: "pending", depuis: Date.now() };
    maj();
    suivre();
  }

  async function suivre() {
    const e = etat.envoye;
    if (!e) return;
    const lots = await lireStatut();
    if (lots) {
      if (!e.id) {
        const nouveau = lots.find((b) => !e.avant.has(b.id));
        if (nouveau) e.id = nouveau.id;
      }
      const mien = e.id ? lots.find((b) => b.id === e.id) : null;
      if (mien) e.statut = mien.status;
      if (e.id && (!mien || mien.status === "done")) return terminer("Appliqué");
    }
    maj();
    clearTimeout(minuterieStatut);
    minuterieStatut = setTimeout(suivre, 1500);
  }

  /** `done` : le code de Claude prend la place de l'aperçu. */
  function terminer(message) {
    clearTimeout(minuterieStatut);
    for (const m of etat.gardes) rendre(m);
    etat.gardes = [];
    etat.envoye = null;
    afficherFlash(message);
  }

  /* ---------------------------------- UI ----------------------------------- */

  const STYLE_PETIT = {
    background: "none",
    border: "0",
    color: C.muted,
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: "1",
    padding: "2px 4px",
    fontFamily: FONT,
  };
  const STYLE_FLECHE = {
    width: "26px",
    height: "26px",
    padding: "0",
    border: "1px solid " + C.border,
    borderRadius: "7px",
    background: C.bg2,
    color: C.text,
    cursor: "pointer",
    fontSize: "10px",
    lineHeight: "1",
    fontFamily: FONT,
  };

  function creerUI() {
    if (ui) return;
    const racine = noeud("div", { "data-overlay-ui": "", "data-buildyoursite-ui": "", "data-deplacer": "" }, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      zIndex: "2147483000",
      pointerEvents: "none",
      fontFamily: FONT,
      display: "block",
    });

    const cadre = noeud("div", {}, {
      position: "fixed",
      display: "none",
      outline: "2px solid " + C.cible,
      outlineOffset: "1px",
      borderRadius: "3px",
      pointerEvents: "none",
    });

    /* panneau : une mini fenêtre, ses points en haut à gauche */
    const points = noeud("div", { role: "group", "aria-label": "Position parmi les voisins" }, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
    });
    const nom = noeud("span", {}, {
      flex: "1",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: C.muted,
      fontSize: "10.5px",
    });
    const btnParent = noeud("button", { type: "button", title: "Sélectionner l'élément qui le contient", "aria-label": "Sélectionner le parent", text: "↑ parent" }, Object.assign({}, STYLE_PETIT, { fontSize: "10.5px" }));
    const btnFermer = noeud("button", { type: "button", title: "Fermer (Échap)", "aria-label": "Fermer", text: "✕" }, STYLE_PETIT);
    const entete = noeud("div", { title: "Glissez la fenêtre par son titre pour la déplacer" }, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "9px 10px 7px",
      cursor: "grab",
      touchAction: "none",
    }, [points, nom, btnParent, btnFermer]);

    const fleche = (txt, label, dx, dy) => {
      const b = noeud("button", { type: "button", title: label, "aria-label": label, text: txt }, STYLE_FLECHE);
      b.addEventListener("click", (ev) => pousser(dx * (ev.shiftKey ? 10 : 1), dy * (ev.shiftKey ? 10 : 1)));
      return b;
    };
    const pion = noeud("div", { role: "button", tabindex: "0", title: "Glisser pour déplacer (Maj : un seul axe)", "aria-label": "Glisser pour déplacer" }, {
      width: "26px",
      height: "26px",
      borderRadius: "999px",
      border: "2px solid " + C.accent,
      background: C.accent + "33",
      cursor: "grab",
      touchAction: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }, [noeud("span", {}, { width: "6px", height: "6px", borderRadius: "999px", background: C.accent })]);
    const vide = () => noeud("span", {}, {});
    const croix = noeud("div", { role: "group", "aria-label": "Croix directionnelle" }, {
      display: "grid",
      gridTemplateColumns: "repeat(3, 26px)",
      gridTemplateRows: "repeat(3, 26px)",
      gap: "2px",
    }, [
      vide(), fleche("▲", "Monter d'un pixel (Maj : dix)", 0, -1), vide(),
      fleche("◀", "Aller à gauche d'un pixel (Maj : dix)", -1, 0), pion, fleche("▶", "Aller à droite d'un pixel (Maj : dix)", 1, 0),
      vide(), fleche("▼", "Descendre d'un pixel (Maj : dix)", 0, 1), vide(),
    ]);

    const lectureX = noeud("div", {}, {});
    const lectureY = noeud("div", {}, {});
    const lecture = noeud("div", { "aria-live": "polite" }, { fontFamily: MONO, fontSize: "11px", color: C.text, display: "grid", gap: "2px", fontVariantNumeric: "tabular-nums" }, [lectureX, lectureY]);
    const btnRemettre = noeud("button", { type: "button", title: "Remettre l'élément à sa place d'origine", text: "↺ Remettre" }, Object.assign({}, STYLE_PETIT, { padding: "2px 0", fontSize: "11px", textAlign: "left" }));
    const note = noeud("div", {}, { fontSize: "10px", lineHeight: "1.3", color: C.muted });
    const colonne = noeud("div", {}, { display: "flex", flexDirection: "column", gap: "6px", minWidth: "0", flex: "1" }, [lecture, btnRemettre, note]);
    const corps = noeud("div", {}, { display: "flex", gap: "12px", alignItems: "center", padding: "2px 12px 12px" }, [croix, colonne]);

    const panneau = noeud("div", { role: "dialog", "aria-label": "Déplacer l'élément" }, {
      position: "fixed",
      display: "none",
      width: LARGEUR_PANNEAU + "px",
      pointerEvents: "auto",
      background: C.bg,
      border: "1px solid " + C.border,
      borderRadius: "12px",
      boxShadow: "0 12px 40px rgba(0,0,0,.45)",
      color: C.text,
      fontSize: "11.5px",
    }, [entete, corps]);

    /* la barre d'envoi, en bas à gauche : l'overlay occupe le coin opposé */
    const texteBarre = noeud("span", {}, { color: C.text });
    const btnEnvoyer = noeud("button", { type: "button", text: "Envoyer" }, {
      background: C.accent,
      border: "0",
      borderRadius: "999px",
      color: "#fff",
      cursor: "pointer",
      fontSize: "11.5px",
      fontWeight: "600",
      padding: "5px 12px",
      fontFamily: FONT,
    });
    const btnAnnuler = noeud("button", { type: "button", text: "Tout annuler" }, Object.assign({}, STYLE_PETIT, { fontSize: "11.5px" }));
    const btnLiberer = noeud("button", { type: "button", title: "Retirer l'aperçu sans attendre Claude", text: "Libérer" }, Object.assign({}, STYLE_PETIT, { fontSize: "11.5px" }));
    const barre = noeud("div", { role: "status" }, {
      position: "fixed",
      left: "14px",
      bottom: "14px",
      display: "none",
      alignItems: "center",
      gap: "10px",
      pointerEvents: "auto",
      background: C.bg,
      border: "1px solid " + C.border,
      borderRadius: "999px",
      boxShadow: "0 8px 28px rgba(0,0,0,.4)",
      padding: "6px 8px 6px 14px",
      fontSize: "11.5px",
      color: C.text,
    }, [texteBarre, btnEnvoyer, btnAnnuler, btnLiberer]);

    racine.appendChild(cadre);
    racine.appendChild(panneau);
    racine.appendChild(barre);
    document.body.appendChild(racine);

    /* --- gestes --- */
    btnFermer.addEventListener("click", deselectionner);
    btnParent.addEventListener("click", () => {
      const p = etat.cible && etat.cible.parentElement;
      if (p && p !== document.body && p !== document.documentElement) choisir(p);
    });
    btnRemettre.addEventListener("click", remettre);
    btnEnvoyer.addEventListener("click", envoyer);
    btnAnnuler.addEventListener("click", toutAnnuler);
    btnLiberer.addEventListener("click", () => terminer("Aperçu retiré"));

    points.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-point]");
      if (b && etat.cible && !etat.envoye) definirOrdre(etat.cible, Number(b.getAttribute("data-point")));
    });

    pion.addEventListener("pointerdown", (ev) => {
      if (!etat.cible || etat.envoye) return;
      ev.preventDefault();
      pion.setPointerCapture(ev.pointerId);
      const m = rec(etat.cible);
      m.utilisateur = true;
      assurerTranslatable(m);
      etat.drag = { px: ev.clientX, py: ev.clientY, x0: m.x, y0: m.y, m };
      pion.style.cursor = "grabbing";
    });
    pion.addEventListener("pointermove", (ev) => {
      const d = etat.drag;
      if (!d) return;
      let dx = ev.clientX - d.px;
      let dy = ev.clientY - d.py;
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      d.m.x = Math.round(d.x0 + dx);
      d.m.y = Math.round(d.y0 + dy);
      pose(d.m);
      maj();
    });
    const finGlisse = (ev) => {
      if (!etat.drag) return;
      etat.drag = null;
      pion.style.cursor = "grab";
      try {
        pion.releasePointerCapture(ev.pointerId);
      } catch {
        /* déjà relâché */
      }
      maj();
    };
    pion.addEventListener("pointerup", finGlisse);
    pion.addEventListener("pointercancel", finGlisse);

    // Le panneau se déplace par son titre : il ne doit pas cacher les voisins qu'on regarde.
    entete.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button")) return;
      ev.preventDefault();
      entete.setPointerCapture(ev.pointerId);
      etat.dragPanneau = { px: ev.clientX, py: ev.clientY, ox: etat.decPanneau.x, oy: etat.decPanneau.y };
      entete.style.cursor = "grabbing";
    });
    entete.addEventListener("pointermove", (ev) => {
      const d = etat.dragPanneau;
      if (!d) return;
      etat.decPanneau = { x: d.ox + ev.clientX - d.px, y: d.oy + ev.clientY - d.py };
      placer();
    });
    const finPanneau = (ev) => {
      if (!etat.dragPanneau) return;
      etat.dragPanneau = null;
      entete.style.cursor = "grab";
      try {
        entete.releasePointerCapture(ev.pointerId);
      } catch {
        /* déjà relâché */
      }
    };
    entete.addEventListener("pointerup", finPanneau);
    entete.addEventListener("pointercancel", finPanneau);

    // Au clavier : le pion ou une flèche ayant le focus, les flèches du clavier poussent.
    panneau.addEventListener("keydown", (ev) => {
      const pas = ev.shiftKey ? 10 : 1;
      const v = { ArrowLeft: [-pas, 0], ArrowRight: [pas, 0], ArrowUp: [0, -pas], ArrowDown: [0, pas] }[ev.key];
      if (!v) return;
      ev.preventDefault();
      pousser(v[0], v[1]);
    });

    ui = { racine, cadre, panneau, points, nom, btnParent, lectureX, lectureY, btnRemettre, note, croix, pion, barre, texteBarre, btnEnvoyer, btnAnnuler, btnLiberer };
  }

  /* --------------------------------- rendu --------------------------------- */

  function placer() {
    if (!ui || !etat.cible) return;
    const r = etat.cible.getBoundingClientRect();
    ui.cadre.style.display = "block";
    ui.cadre.style.top = r.top + "px";
    ui.cadre.style.left = r.left + "px";
    ui.cadre.style.width = r.width + "px";
    ui.cadre.style.height = r.height + "px";
    // Le panneau reste là où l'élément a été sélectionné, et ne suit que le
    // défilement : s'il suivait l'élément, les points et les flèches fuiraient
    // sous la souris à chaque clic.
    const a = etat.ancre || r;
    const ds = etat.ancre ? { x: etat.ancre.sx - window.scrollX, y: etat.ancre.sy - window.scrollY } : { x: 0, y: 0 };
    const ar = { left: a.left + ds.x, top: a.top + ds.y, right: a.right + ds.x };
    const w = LARGEUR_PANNEAU;
    const h = ui.panneau.offsetHeight || 130;
    let left = ar.right + 10;
    if (left + w > window.innerWidth - 8) left = ar.left - w - 10;
    if (left < 8) left = Math.max(8, Math.min(window.innerWidth - w - 12, ar.right - w - 8));
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, ar.top));
    ui.panneau.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left + etat.decPanneau.x)) + "px";
    ui.panneau.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, top + etat.decPanneau.y)) + "px";
  }

  function pointStyle(allume) {
    return {
      width: "11px",
      height: "11px",
      padding: "0",
      borderRadius: "999px",
      cursor: "pointer",
      border: "1px solid " + (allume ? C.accent : "#5b5852"),
      background: allume ? C.accent : "#44423d",
      boxShadow: allume ? "0 0 0 3px " + C.accent + "33" : "none",
      transition: "background .12s, box-shadow .12s",
    };
  }

  function maj() {
    if (!ui) return;
    const e = etat.cible && document.contains(etat.cible) ? etat.cible : null;
    const verrou = !!etat.envoye;

    if (!e) {
      ui.panneau.style.display = "none";
      ui.cadre.style.display = "none";
    } else {
      ui.panneau.style.display = "block";
      const m = etat.modifs.get(e);
      const liste = freresDe(e);
      const de = liste.indexOf(e);
      const actuel = m && m.ordre ? m.ordre.vers : de;
      ui.nom.textContent = nomCourt(e);
      const p = e.parentElement;
      ui.btnParent.style.display = p && p !== document.body && p !== document.documentElement ? "inline-block" : "none";

      // la rangée de points : un par voisin, le point allumé est la position
      ui.points.replaceChildren();
      if (de >= 0 && liste.length >= 2) {
        if (liste.length <= MAX_POINTS) {
          liste.forEach((f, i) => {
            const nouvelle = Array.from(liste);
            nouvelle.splice(de, 1);
            nouvelle.splice(i, 0, e);
            const voisin = i === de ? null : nouvelle[i === 0 ? 1 : i - 1];
            const ctx = i === de ? "position d'origine" : i === 0 ? "tout au début" : "juste après " + nomCourt(voisin);
            const b = noeud("button", {
              type: "button",
              "data-point": String(i),
              "aria-label": "Position " + (i + 1) + " sur " + liste.length,
              "aria-pressed": String(i === actuel),
              title: "Position " + (i + 1) + " sur " + liste.length + " : " + ctx,
            }, pointStyle(i === actuel));
            ui.points.appendChild(b);
          });
        } else {
          const plus = (d) => {
            const b = noeud("button", { type: "button", text: d < 0 ? "◀" : "▶", "aria-label": d < 0 ? "Un cran avant" : "Un cran après" }, Object.assign({}, STYLE_PETIT, { fontSize: "10px" }));
            b.addEventListener("click", () => {
              if (!etat.envoye) definirOrdre(e, Math.max(0, Math.min(liste.length - 1, actuel + d)));
            });
            return b;
          };
          ui.points.append(plus(-1), noeud("span", { text: actuel + 1 + " / " + liste.length }, { fontFamily: MONO, fontSize: "11px", color: C.text }), plus(1));
        }
      }

      const t = m ? dTr(m) : { dx: 0, dy: 0 };
      ui.lectureX.textContent = "x  " + signe(t.dx) + " px";
      ui.lectureY.textContent = "y  " + signe(t.dy) + " px";
      ui.btnRemettre.style.display = m && aChange(m) ? "block" : "none";
      ui.note.textContent = verrou ? "Claude applique : patience." : m && m.sansApercu ? "Pas d'aperçu pour l'ordre ici : il sera appliqué à l'envoi." : "";
      ui.croix.style.opacity = verrou ? ".4" : "1";
      ui.croix.style.pointerEvents = verrou ? "none" : "auto";
      ui.points.style.opacity = verrou ? ".4" : "1";
      ui.points.style.pointerEvents = verrou ? "none" : "auto";
      placer();
    }

    // la barre d'envoi
    const n = nbChanges();
    let texte = "";
    if (verrou) texte = etat.envoye.statut === "en_cours" ? "Claude applique…" : "Envoyé · Claude arrive…";
    else if (n > 0) texte = n + (n > 1 ? " déplacements" : " déplacement");
    else if (etat.flash) texte = etat.flash;
    ui.barre.style.display = texte ? "flex" : "none";
    ui.texteBarre.textContent = texte;
    ui.btnEnvoyer.style.display = !verrou && n > 0 ? "inline-block" : "none";
    ui.btnAnnuler.style.display = !verrou && n > 0 ? "inline-block" : "none";
    ui.btnLiberer.style.display = verrou ? "inline-block" : "none";
  }

  /* ------------------------------ sélection --------------------------------- */

  function boucle() {
    if (!etat.cible) {
      boucleActive = false;
      return;
    }
    if (!document.contains(etat.cible)) {
      deselectionner();
      return;
    }
    const r = etat.cible.getBoundingClientRect();
    const cle = [r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight, window.scrollX, window.scrollY].map(Math.round).join();
    if (cle !== dernierRect) {
      dernierRect = cle;
      placer();
    }
    requestAnimationFrame(boucle);
  }

  function choisir(e) {
    if (!e || e === document.body || e === document.documentElement) return deselectionner();
    creerUI();
    if (e !== etat.cible) etat.decPanneau = { x: 0, y: 0 };
    const r = e.getBoundingClientRect();
    etat.ancre = { left: r.left, top: r.top, right: r.right, sx: window.scrollX, sy: window.scrollY };
    etat.cible = e;
    dernierRect = "";
    maj();
    if (!boucleActive) {
      boucleActive = true;
      requestAnimationFrame(boucle);
    }
  }

  function deselectionner() {
    etat.cible = null;
    maj();
  }

  /** Un clic sur un bouton ou une image vise le bouton, pas le texte qu'il contient. */
  function remonter(t) {
    const a = t.closest(ATOMES);
    return a && !a.contains(document.body) ? a : t;
  }

  function lireMode() {
    for (const r of document.querySelectorAll("[role='radio']")) {
      if (!r.closest(UI) || r.closest("[data-deplacer]")) continue;
      if (/^édition$/i.test((r.textContent || "").trim())) return r.getAttribute("aria-checked") === "true";
    }
    return false;
  }

  function verifierMode() {
    const arme = lireMode();
    if (arme === etat.arme) return;
    etat.arme = arme;
    if (!arme) deselectionner();
  }

  // Les clics : l'hôte ouvre sa bulle, nous posons la croix. Mêmes cibles, même phase.
  document.addEventListener(
    "click",
    (ev) => {
      if (!etat.arme || etat.drag) return;
      const t = ev.target;
      if (!(t instanceof Element) || estUI(t)) return;
      choisir(remonter(t));
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Escape") return;
      const d = etat.drag;
      if (d) {
        d.m.x = d.x0;
        d.m.y = d.y0;
        pose(d.m);
        etat.drag = null;
        maj();
        return;
      }
      if (etat.cible) deselectionner();
    },
    true,
  );
  // Alt+E et les boutons de mode changent aria-checked : on relit tout de suite, puis en veille.
  document.addEventListener("click", () => setTimeout(verifierMode, 0), true);
  document.addEventListener("keydown", () => setTimeout(verifierMode, 0), true);
  setInterval(verifierMode, 400);
  window.addEventListener("resize", () => placer(), { passive: true });
  window.addEventListener("scroll", () => placer(), { passive: true, capture: true });
})();
