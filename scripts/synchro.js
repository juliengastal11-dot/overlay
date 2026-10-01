/* ---------------------------------------------------------------------------
   Synchronisation de la fenêtre principale vers les téléphones.

   Injecté par serveur-overlay.mjs dans chaque page HTML, avant overlay.js.
   Le même script joue deux rôles, selon qui l'exécute :

   - Dans la fenêtre principale, il publie : la page affichée, l'endroit où
     l'on se trouve dans cette page, et l'état de son navigateur (localStorage ;
     les cookies, le serveur les lit dans l'envoi).
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

  /* ----------------------------- les gestes ------------------------------- */

  /* Ce qu'on fait dans la fenêtre principale se rejoue dans les téléphones : un
     clic (une question de FAQ, un menu, un onglet, une fenêtre surgissante),
     une saisie, une touche, le défilement d'un carrousel. Sans ça, la FAQ
     ouverte à gauche restait fermée dans les deux iPhones : constaté le
     2026-10-01. On ne rejoue pas le geste à l'aveugle : on retrouve le même
     élément dans le téléphone, et on vérifie qu'il est dans l'état où il était
     avant le clic. Déjà ouvert ici, il ne se referme pas. */

  const INTERACTIF =
    "a, button, summary, label, input, select, textarea, option, [contenteditable=''], [contenteditable='true'], " +
    "[role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], " +
    "[role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=combobox], [role=slider], [role=link], " +
    "[aria-expanded], [aria-haspopup], [aria-pressed], [aria-controls], [tabindex]:not([tabindex='-1'])";

  // Le plus proche élément qui réagit au clic ; à défaut, l'élément touché.
  const cibleDe = (el) => (el && el.closest ? el.closest(INTERACTIF) || el : null);

  // Les identifiants générés (React, Radix, Headless UI) ne servent pas à
  // reconnaître un élément : ils peuvent changer d'un rendu à l'autre.
  const idStable = (id) => (id && !/[:«»]|^_R|^radix-|^headlessui-|^react-aria/.test(id) ? id : "");

  function cleDe(el) {
    const a = (n) => el.getAttribute(n) || "";
    return [el.tagName, idStable(el.id), a("name"), a("type"), a("role"),
      a("aria-label") || a("title") || a("alt") || a("placeholder"), a("href")].join("|");
  }
  const texteDe = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);

  /** Les éléments de même balise, mêmes attributs et même texte, dans l'ordre du document. */
  function semblables(balise, cle, texte) {
    const liste = [];
    for (const el of document.getElementsByTagName(balise)) {
      if (cleDe(el) === cle && texteDe(el) === texte && !estUi(el)) liste.push(el);
    }
    return liste;
  }

  /** Le chemin depuis <body> : le rang parmi les enfants à chaque niveau, sans
      compter l'interface d'édition, qui n'existe pas dans les téléphones. */
  function cheminDe(el) {
    const c = [];
    for (let n = el; n && n !== document.body && n.parentElement; n = n.parentElement) {
      let i = 0;
      for (let f = n.parentElement.firstElementChild; f && f !== n; f = f.nextElementSibling) if (!estUi(f)) i++;
      c.unshift(i);
    }
    return c;
  }
  function suivreChemin(c) {
    let n = document.body;
    for (const i of c || []) {
      let k = -1;
      let f = n.firstElementChild;
      for (; f; f = f.nextElementSibling) if (!estUi(f) && ++k === i) break;
      if (!f) return null;
      n = f;
    }
    return n === document.body ? null : n;
  }

  function decrire(el) {
    const balise = el.tagName.toLowerCase();
    const cle = cleDe(el);
    const texte = texteDe(el);
    return { balise, cle, texte, rang: semblables(balise, cle, texte).indexOf(el), chemin: cheminDe(el) };
  }

  /** Le même élément, dans cette page-ci. Par son chemin s'il n'a pas changé ;
      sinon par son rang parmi ses semblables, ce qui survit à une mise en page
      mobile qui ajoute ou retire des blocs ; sinon, même place, même balise :
      c'est qu'on vient de retoucher son texte. */
  function retrouverCible(d) {
    if (!d) return null;
    const parChemin = suivreChemin(d.chemin);
    const memeBalise = parChemin && parChemin.tagName.toLowerCase() === d.balise;
    if (memeBalise && cleDe(parChemin) === d.cle && texteDe(parChemin) === d.texte) return parChemin;
    const liste = semblables(d.balise, d.cle, d.texte);
    if (liste.length) return liste[Math.max(0, Math.min(d.rang, liste.length - 1))];
    return memeBalise ? parChemin : null;
  }

  /** L'état visible d'un élément : coché, ouvert, déplié, sélectionné. */
  function etatDe(el) {
    if (!el) return null;
    const x = el.tagName === "LABEL" && el.control ? el.control : el;
    if (x.tagName === "INPUT" && /^(checkbox|radio)$/i.test(x.type)) return "coche:" + x.checked;
    if (x.tagName === "SUMMARY" && x.parentElement && x.parentElement.tagName === "DETAILS") return "ouvert:" + x.parentElement.open;
    const v = ["aria-expanded", "aria-selected", "aria-pressed", "aria-checked", "data-state"].map((n) => x.getAttribute(n));
    return v.some((s) => s !== null) ? "aria:" + v.join(",") : null;
  }

  /** Un lien qui change de page ou d'ancre : la synchronisation de la page et du
      défilement s'en charge déjà. Le rejouer ferait naviguer deux fois. */
  function lienQuiNavigue(el) {
    const a = el.closest && el.closest("a[href]");
    if (!a) return false;
    const href = (a.getAttribute("href") || "").trim();
    return href !== "" && href !== "#" && !/^javascript:/i.test(href);
  }

  // En mode Édition, un clic sert à commenter, pas à utiliser le site.
  function enEdition() {
    try {
      return ["buildyoursite:mode", "overlay:mode"].some((k) => sessionStorage.getItem(k) === "edition");
    } catch {
      return false;
    }
  }

  const estChamp = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  /* Le hasard partagé (posé par le serveur en tête de page) repart de l'adresse
     après une navigation sans rechargement, dans chaque fenêtre. */
  function surveillerAdresse(rappel) {
    const chemin = () => location.pathname + location.search;
    let avant = chemin();
    const verifier = () => {
      const c = chemin();
      if (c === avant) return;
      avant = c;
      if (window.__overlayHasard) window.__overlayHasard(c);
      if (rappel) rappel(c);
    };
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function (...a) {
        const r = orig.apply(this, a);
        verifier();
        return r;
      };
    }
    window.addEventListener("popstate", verifier);
    return verifier;
  }

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

  /* Le localStorage de la fenêtre principale, pour les téléphones. Un cache
     volumineux n'est pas un réglage : une valeur de plus de 32 Ko reste ici. */
  function instantaneLocal() {
    const o = {};
    let total = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const cle = localStorage.key(i);
        if (!cle || cle.startsWith("__overlay")) continue;
        const v = localStorage.getItem(cle);
        if (v === null || v.length > 32768) continue;
        total += cle.length + v.length;
        if (total > 400000) break;
        o[cle] = v;
      }
    } catch {
      /* stockage interdit : rien à copier */
    }
    return o;
  }

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

    // L'état du navigateur part quand il change : le bandeau des cookies refusé,
    // une connexion, un panier. Les cookies servent ici à voir le changement ;
    // le serveur les prend dans l'entête de l'envoi, HttpOnly compris.
    let dernierEtat = null;
    const stockage = () => {
      if (muet()) return;
      const local = instantaneLocal();
      const cle = JSON.stringify(local) + "\n" + document.cookie;
      if (cle === dernierEtat) return;
      dernierEtat = cle;
      envoyer({ type: "stockage", local });
    };

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
    surveillerAdresse(() => setTimeout(navigation, 0));
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
      stockage();
      navigation();
      if (window.scrollY !== dernierY) defilement();
    }, 400);

    stockage();
    page();
    defilement();
    window.addEventListener("load", () => setTimeout(defilement, 50));
    ecouterGestes();
  }

  /** Les gestes de l'utilisateur, à rejouer dans les téléphones. Seulement les
      vrais (`isTrusted`), hors de l'interface d'édition, et pas en mode Édition. */
  function ecouterGestes() {
    const humain = (e) => e.isTrusted && e.target && e.target.nodeType === 1 && !estUi(e.target) && !enEdition();
    const avantClic = new WeakMap();
    let derniereMain = 0;
    const main = () => (derniereMain = Date.now());

    // L'état d'avant se lit à l'appui : certains composants (les menus de Radix)
    // s'ouvrent dès l'appui, avant le clic.
    window.addEventListener("pointerdown", (e) => {
      main();
      if (!humain(e)) return;
      const el = cibleDe(e.target);
      if (el) avantClic.set(el, { etat: etatDe(el), t: Date.now() });
    }, true);
    window.addEventListener("wheel", main, { capture: true, passive: true });

    window.addEventListener("click", (e) => {
      if (!humain(e)) return;
      const el = cibleDe(e.target);
      if (!el || lienQuiNavigue(el)) return;
      const memo = avantClic.get(el);
      avantClic.delete(el);
      let avant = memo && Date.now() - memo.t < 2000 ? memo.etat : etatDe(el);
      // Sans appui (un clic au clavier, ou relayé par une étiquette), une case est
      // déjà basculée quand le clic arrive : son état d'avant est l'inverse.
      if (!memo) {
        const x = el.tagName === "LABEL" && el.control ? el.control : el;
        if (x.tagName === "INPUT" && /^(checkbox|radio)$/i.test(x.type)) avant = "coche:" + !x.checked;
      }
      envoyer({ type: "clic", cible: decrire(el), avant });
    }, true);

    // Une saisie : au plus un envoi toutes les 80 ms par champ, toujours la dernière valeur.
    const saisies = new WeakMap();
    window.addEventListener("input", (e) => {
      if (!humain(e) || !estChamp(e.target)) return;
      const el = e.target;
      if (el.tagName === "INPUT" && /^(checkbox|radio|file|submit|button|reset|image)$/i.test(el.type)) return;
      clearTimeout(saisies.get(el));
      saisies.set(el, setTimeout(() => {
        envoyer({ type: "saisie", cible: decrire(el), valeur: el.isContentEditable ? el.innerText : el.value });
      }, 80));
    }, true);

    // Échap ferme une fenêtre surgissante ; les flèches font tourner un carrousel
    // ou changent d'onglet, quand un élément de la page a le focus. Sur la page
    // elle-même, elles la font défiler : le défilement est déjà suivi.
    const TOUCHES = /^(Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/;
    window.addEventListener("keydown", (e) => {
      main();
      if (!humain(e) || !TOUCHES.test(e.key)) return;
      const actif = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      if (e.key !== "Escape" && (!actif || estChamp(actif))) return;
      envoyer({ type: "touche", touche: e.key, code: e.code, cible: actif && !estUi(actif) ? decrire(actif) : null });
    }, true);

    // Le défilement d'un élément (carrousel, fenêtre surgissante), en proportion,
    // et seulement juste après un geste : un défilement automatique tourne aussi
    // dans les téléphones, inutile de le leur imposer.
    const defilements = new WeakMap();
    document.addEventListener("scroll", (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return;
      if (estUi(el) || enEdition() || Date.now() - derniereMain > 1500 || defilements.has(el)) return;
      defilements.set(el, setTimeout(() => {
        defilements.delete(el);
        const mx = el.scrollWidth - el.clientWidth;
        const my = el.scrollHeight - el.clientHeight;
        envoyer({ type: "defilement-element", cible: decrire(el), x: mx > 0 ? el.scrollLeft / mx : 0, y: my > 0 ? el.scrollTop / my : 0 });
      }, 50));
    }, true);
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

  /* L'état du navigateur, recopié depuis la fenêtre principale. */

  // Les clés que les outils de mesure d'audience et le serveur de développement
  // réécrivent sans cesse : leur changement ne doit pas recharger les téléphones.
  const VOLATIL = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|_clck|_clsk|__utm|_pk_|_uet|_dd_s|ph_|mp_|ajs_|amplitude|AMP_|intercom|__hs|hubspot|__next|__overlay)/i;
  const CLE_VU = "__overlayStockage";

  // Une valeur qui ne change que par ses longues suites de chiffres (horodatage,
  // identifiant de visite) n'a rien changé de visible.
  const sansHorodatage = (v) => String(v).replace(/\d{6,}/g, "#");
  function notable(nom, avant, apres) {
    if (VOLATIL.test(nom)) return false;
    if (avant === null || avant === undefined) return true;
    return sansHorodatage(avant) !== sansHorodatage(apres);
  }

  function cookies(texte) {
    const m = new Map();
    for (const morceau of String(texte || "").split(/;\s*/)) {
      const i = morceau.indexOf("=");
      if (i > 0) m.set(morceau.slice(0, i), morceau.slice(i + 1));
    }
    return m;
  }

  function poserCookie(nom, valeur, effacer) {
    const securise = /^__(Host|Secure)-/.test(nom) ? "; Secure" : "";
    document.cookie = effacer
      ? `${nom}=; path=/; max-age=0${securise}`
      : `${nom}=${valeur}; path=/; SameSite=Lax${securise}`;
  }

  /** Recopie cookies et localStorage de la fenêtre principale. Renvoie vrai si
      un changement se voit : le site ne les relit qu'au chargement, il faut
      alors recharger. Une version déjà appliquée ne fait rien, ce qui exclut
      toute boucle de rechargements. */
  function appliquerStockage(e) {
    let vu = {};
    try {
      vu = JSON.parse(sessionStorage.getItem(CLE_VU) || "{}");
    } catch {
      vu = {};
    }
    if (vu.version === e.version) return false;
    let recharger = false;

    const principaux = cookies(e.cookies);
    const actuels = cookies(document.cookie);
    for (const [nom, valeur] of principaux) {
      if (actuels.get(nom) === valeur) continue;
      if (notable(nom, actuels.get(nom), valeur)) recharger = true;
      poserCookie(nom, valeur, false);
    }
    // Un cookie disparu de la fenêtre principale (déconnexion, choix effacé)
    // disparaît aussi, s'il venait d'elle.
    for (const nom of vu.cookies || []) {
      if (principaux.has(nom) || !actuels.has(nom)) continue;
      poserCookie(nom, "", true);
      if (!VOLATIL.test(nom)) recharger = true;
    }

    const local = e.local || {};
    try {
      for (const [cle, valeur] of Object.entries(local)) {
        const avant = localStorage.getItem(cle);
        if (avant === valeur) continue;
        if (notable(cle, avant, valeur)) recharger = true;
        localStorage.setItem(cle, valeur);
      }
      for (const cle of vu.local || []) {
        if (cle in local || localStorage.getItem(cle) === null) continue;
        localStorage.removeItem(cle);
        if (!VOLATIL.test(cle)) recharger = true;
      }
    } catch {
      /* stockage plein ou interdit */
    }

    try {
      sessionStorage.setItem(CLE_VU, JSON.stringify({ version: e.version, cookies: [...principaux.keys()], local: Object.keys(local) }));
    } catch {
      /* sans mémoire, au pire un rechargement de trop : la fois suivante, rien ne diffère plus */
    }
    return recharger;
  }

  /* Les gestes de la fenêtre principale, rejoués ici. */

  /** Un toucher de doigt, dans l'ordre où un iPhone envoie ses événements :
      pointeur, toucher, puis souris de compatibilité et clic. Si la page annule
      la fin du toucher, le navigateur n'envoie pas la suite : nous non plus.
      Seul un champ prend le focus, comme sous le doigt : un bouton ne garde pas
      d'anneau de focus sur un téléphone. */
  function tapoter(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y };
    const doigt = { ...base, pointerId: 7, pointerType: "touch", isPrimary: true, width: 20, height: 20 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...doigt, button: 0, buttons: 1, pressure: 0.5 }));
    let annule = false;
    try {
      const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x + scrollX, pageY: y + scrollY, radiusX: 10, radiusY: 10, force: 0.5 });
      el.dispatchEvent(new TouchEvent("touchstart", { ...base, touches: [t], targetTouches: [t], changedTouches: [t] }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...doigt, button: 0, buttons: 0, pressure: 0 }));
      annule = !el.dispatchEvent(new TouchEvent("touchend", { ...base, touches: [], targetTouches: [], changedTouches: [t] }));
    } catch {
      el.dispatchEvent(new PointerEvent("pointerup", { ...doigt, button: 0, buttons: 0, pressure: 0 }));
    }
    if (annule) return;
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1, detail: 1 }));
    if (estChamp(el)) el.focus({ preventScroll: true });
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0, buttons: 0, detail: 1 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, button: 0, buttons: 0, detail: 1 }));
  }

  /** Une saisie, posée comme le ferait le clavier : par le setter natif, pour que
      React et les autres bibliothèques la voient, puis l'événement `input`. */
  function remplir(el, valeur) {
    if (el.isContentEditable) {
      el.innerText = valeur;
    } else {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, valeur);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (el.tagName === "SELECT") el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function appuyer(e) {
    const el = (e.cible && retrouverCible(e.cible)) || document.activeElement || document.body;
    if (el !== document.body && el !== document.activeElement && el.focus) el.focus({ preventScroll: true });
    const init = { key: e.touche, code: e.code, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function defilerElement(e) {
    const el = retrouverCible(e.cible);
    if (!el) return;
    const mx = el.scrollWidth - el.clientWidth;
    const my = el.scrollHeight - el.clientHeight;
    el.scrollTo({ left: (e.x || 0) * mx, top: (e.y || 0) * my, behavior: "instant" });
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
    surveillerAdresse();
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
      } else if (e.type === "stockage") {
        if (appliquerStockage(e)) location.reload();
      } else if (e.type === "clic") {
        const el = retrouverCible(e.cible);
        // Pas dans l'état d'avant le clic : il est déjà dans celui d'après.
        if (!el || (e.avant != null && etatDe(el) !== e.avant)) return;
        tapoter(el);
        apresGeste();
      } else if (e.type === "saisie") {
        const el = retrouverCible(e.cible);
        if (el) remplir(el, e.valeur);
      } else if (e.type === "touche") {
        appuyer(e);
        apresGeste();
      } else if (e.type === "defilement-element") {
        defilerElement(e);
      }
    };

    // Le contenu change sous nos pieds : rechargement à chaud, images qui
    // arrivent, animation d'entrée. On se recale sur le dernier repère reçu.
    let attente = null;
    const recaler = () => {
      clearTimeout(attente);
      attente = setTimeout(() => appliquer(dernier), 250);
    };
    // Un geste ouvre ou ferme une partie de la page (une réponse de FAQ, un
    // menu) : on se recale une fois l'animation passée. Une question ouverte
    // change un attribut, que l'observateur ci-dessous ne suit pas.
    const apresGeste = () => {
      setTimeout(recaler, 60);
      setTimeout(recaler, 700);
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
