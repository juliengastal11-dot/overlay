/* ---------------------------------------------------------------------------
   Synchronisation de la fenêtre principale vers les téléphones.

   Injecté par serveur-overlay.mjs dans chaque page HTML, avant overlay.js.
   Le même script joue deux rôles, selon qui l'exécute :

   - Dans la fenêtre principale, il publie : la page affichée, et l'endroit où
     l'on se trouve dans cette page.
   - Dans un téléphone (agent utilisateur marqué `OverlayTelephone/`), il
     écoute et rejoue. Il y masque aussi l'overlay d'édition : on modifie
     dans la fenêtre principale, les téléphones ne font que montrer.

   Le défilement ne se transmet pas en pourcentage. Une section haute de
   600 pixels sur ordinateur en fait souvent 1 400 sur téléphone : un même
   pourcentage tomberait ailleurs. On transmet donc un repère : l'élément de la
   page qui se trouve en haut de l'écran, et la fraction du chemin parcourue
   jusqu'au repère suivant. Le téléphone retrouve les deux mêmes éléments dans
   sa propre mise en page et se place entre eux, à la même fraction.
--------------------------------------------------------------------------- */
(() => {
  if (window.__overlaySynchro) return;
  window.__overlaySynchro = true;

  const TELEPHONE = /OverlayTelephone\//.test(navigator.userAgent);
  const POINT = "/__overlay/synchro";
  const REPERES =
    "main > *, header, footer, nav, section, article, aside, [data-src], h1, h2, h3, h4, h5, h6, p, li, figure, img, picture, video, blockquote, form, table, pre";
  const MAX_REPERES = 3000;

  /* ------------------------------- repères -------------------------------- */

  const estUi = (el) => !!el.closest("[data-overlay-ui], [data-buildyoursite-ui]");

  /** La liste des repères, dans l'ordre du document. Elle est identique dans la
      fenêtre principale et dans les téléphones, car c'est la même page : seul
      l'agencement change, pas la structure. L'interface d'édition en est exclue,
      puisqu'elle n'existe pas dans les téléphones. */
  function reperes() {
    const tous = document.querySelectorAll(REPERES);
    const liste = [];
    for (let i = 0; i < tous.length && liste.length < MAX_REPERES; i++) {
      if (!estUi(tous[i])) liste.push(tous[i]);
    }
    return liste;
  }

  function haut(el) {
    if (!el || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return r.top + window.scrollY;
  }

  function signature(el) {
    if (!el) return "";
    return el.tagName + ":" + (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
  }

  /* Un en-tête collant reste en haut de l'écran pendant tout le défilement : il
     serait toujours « l'élément du haut ». On écarte tout ce qui est fixe ou
     collant, et ce qu'il contient. La liste se recalcule quand la page change. */
  let flottants = [];
  let flottantsDate = 0;
  function rafraichirFlottants() {
    flottants = [];
    const candidats = document.querySelectorAll("header, nav, [class*='sticky'], [class*='fixed'], [style*='position']");
    for (const el of candidats) {
      const p = getComputedStyle(el).position;
      if (p === "fixed" || p === "sticky") flottants.push(el);
    }
    flottantsDate = Date.now();
  }
  const dansFlottant = (el) => flottants.some((f) => f === el || f.contains(el));

  /* ------------------------ fenêtre principale ---------------------------- */

  function etatDefilement() {
    const s = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (s <= 1) return { type: "defilement", haut: true };
    if (max > 0 && s >= max - 2) return { type: "defilement", bas: true };

    if (Date.now() - flottantsDate > 2000) rafraichirFlottants();
    const liste = reperes();
    let a = -1, ta = -Infinity, b = -1, tb = Infinity;
    for (let i = 0; i < liste.length; i++) {
      const el = liste[i];
      if (dansFlottant(el)) continue;
      const t = haut(el);
      if (t === null) continue;
      if (t <= s + 1) {
        if (t >= ta) { ta = t; a = i; }
      } else if (t < tb) {
        tb = t; b = i;
      }
    }
    const etat = { type: "defilement", ratio: max > 0 ? s / max : 0 };
    if (a >= 0 && b >= 0 && tb > ta) {
      etat.a = a;
      etat.b = b;
      etat.f = (s - ta) / (tb - ta);
      etat.sa = signature(liste[a]);
      etat.sb = signature(liste[b]);
    }
    return etat;
  }

  /* Un panneau replié mesure zéro pixel : sa mise en page n'a plus de sens, et
     ses positions enverraient les téléphones n'importe où. On se tait jusqu'à
     ce qu'il réapparaisse ; les téléphones gardent la dernière bonne position. */
  const muet = () => document.hidden || window.innerWidth === 0 || window.innerHeight === 0;

  function envoyer(objet) {
    if (muet()) return;
    try {
      fetch(POINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(objet),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* serveur arrêté : rien à faire */
    }
  }

  function publier() {
    // Identifiant de ce chargement : s'il change, la page a été rechargée, et les
    // téléphones se rechargent aussi. C'est ce qui met à jour un site statique.
    const ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const cheminCourant = () => location.pathname + location.search;
    let dernierChemin = cheminCourant();
    let dernierY = -1;
    let minuterie = null;
    let dernierEnvoi = 0;

    const page = () => envoyer({ type: "page", url: cheminCourant(), id: ID });

    const defilement = () => {
      dernierY = window.scrollY;
      envoyer(etatDefilement());
      dernierEnvoi = Date.now();
    };

    // Au plus 25 envois par seconde, et toujours le dernier état.
    const auDefilement = () => {
      const attente = 40 - (Date.now() - dernierEnvoi);
      clearTimeout(minuterie);
      if (attente <= 0) defilement();
      else minuterie = setTimeout(defilement, attente);
    };

    const navigation = () => {
      const c = cheminCourant();
      if (c === dernierChemin) return;
      dernierChemin = c;
      page();
      setTimeout(defilement, 120);
    };

    // Les sites à navigation côté client (Next, Vite…) changent d'adresse sans
    // recharger. On écoute l'historique, et on vérifie quand même régulièrement.
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function (...a) {
        const r = orig.apply(this, a);
        setTimeout(navigation, 0);
        return r;
      };
    }
    window.addEventListener("popstate", navigation);
    window.addEventListener("scroll", auDefilement, { passive: true });
    window.addEventListener("resize", auDefilement);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        page();
        defilement();
      }
    });

    // Filet de sécurité : un panneau masqué ne déclenche plus les événements de
    // défilement. Une vérification lente rattrape ce qu'ils auraient manqué.
    let etaitMuet = muet();
    setInterval(() => {
      // Le panneau réapparaît : on republie tout, les téléphones se recalent.
      const m = muet();
      if (etaitMuet && !m) {
        page();
        defilement();
      }
      etaitMuet = m;
      navigation();
      if (window.scrollY !== dernierY) defilement();
    }, 400);

    page();
    defilement();
    window.addEventListener("load", () => setTimeout(defilement, 50));
  }

  /* ------------------------------ téléphone ------------------------------- */

  function masquerEdition() {
    // overlay.js vérifie ce drapeau avant de se monter : dans un téléphone, il ne
    // se monte pas. L'overlay d'un projet /buildyoursite, lui, fait partie du
    // site : on le cache.
    window.__overlayMonte = true;
    const style = document.createElement("style");
    style.textContent = "[data-overlay-ui],[data-buildyoursite-ui]{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  function retrouver(liste, i, sig) {
    if (i === undefined || i < 0) return null;
    if (liste[i] && signature(liste[i]) === sig) return liste[i];
    // La structure diffère parfois d'un écran à l'autre (un menu rendu seulement
    // sur mobile) : on cherche le même élément un peu plus loin, des deux côtés.
    for (let d = 1; d <= 25; d++) {
      for (const j of [i - d, i + d]) {
        if (liste[j] && signature(liste[j]) === sig) return liste[j];
      }
    }
    // Rien d'identique : c'est souvent que le texte vient d'être modifié, ce qui
    // est tout l'objet de l'overlay. Même place, même balise : c'est lui. Sans ce
    // repli, une retouche de titre envoyait les téléphones ailleurs. Constaté.
    const balise = (sig || "").split(":")[0];
    if (liste[i] && liste[i].tagName === balise) return liste[i];
    return null;
  }

  function aller(y) {
    window.scrollTo({ top: Math.max(0, Math.round(y)), left: 0, behavior: "instant" });
  }

  function appliquer(e) {
    if (!e) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (e.haut) return aller(0);
    if (e.bas) return aller(max);
    if (e.a !== undefined) {
      const liste = reperes();
      const ea = retrouver(liste, e.a, e.sa);
      const eb = retrouver(liste, e.b, e.sb);
      const ta = haut(ea);
      const tb = haut(eb);
      if (ta !== null && tb !== null && tb > ta) return aller(ta + e.f * (tb - ta));
      if (ta !== null) return aller(ta);
    }
    aller((e.ratio || 0) * max);
  }

  function suivre() {
    masquerEdition();
    let idVu = null;
    let dernier = null;

    const src = new EventSource(POINT);
    src.onmessage = (m) => {
      let e;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "page") {
        const ici = location.pathname + location.search;
        if (e.url && e.url !== ici) {
          location.replace(e.url);
          return;
        }
        if (idVu && e.id && e.id !== idVu) {
          location.reload();
          return;
        }
        idVu = e.id || idVu;
      } else if (e.type === "defilement") {
        dernier = e;
        appliquer(e);
      }
    };

    // Le contenu change sous nos pieds : rechargement à chaud, images qui
    // arrivent, animation d'entrée. On se recale sur le dernier repère reçu.
    let attente = null;
    const recaler = () => {
      clearTimeout(attente);
      attente = setTimeout(() => appliquer(dernier), 250);
    };
    window.addEventListener("load", recaler);
    window.addEventListener("resize", recaler);
    const demarrer = () => {
      new MutationObserver(recaler).observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.body) demarrer();
    else document.addEventListener("DOMContentLoaded", demarrer);
  }

  if (TELEPHONE) suivre();
  else publier();
})();
