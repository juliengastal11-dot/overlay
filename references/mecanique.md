# Overlay : mécanique

## Côté navigateur

`scripts/overlay.js` est injecté par `scripts/serveur-overlay.mjs` dans chaque page HTML
servie. Jamais dans le code du site.

- Survol → contour pointillé sur l'élément visé
- Clic → sélection figée en trait plein, la bulle s'ouvre
- `Entrée` → le commentaire est enregistré, une pastille numérotée reste sur l'élément
- `Maj+Entrée` → retour à la ligne
- `Échap` → ferme la bulle
- `Alt+E` (ou la barre en bas à droite) → bascule Édition ⇄ Navigation

En mode Édition les clics sont interceptés : la page ne navigue pas. Pour changer de page,
l'utilisateur bascule en Navigation. Le mode et la position de la barre (déplaçable par son
fond) sont retenus le temps de la session du navigateur.

Images : bouton 📎 ou **Ctrl+V** dans la bulle. Quatre maximum par commentaire.

Deux modes d'envoi, dans la barre :
- **Groupé** (défaut) : les commentaires s'empilent, « Envoyer · N » les envoie ensemble
- **Changement immédiat** : chaque validation part seule

Si la page porte déjà l'overlay de `/buildyoursite` (`[data-buildyoursite-ui]`), le script ne
se monte pas.

## Sur le disque

`POST /__overlay/comments` écrit dans `.overlay/comments.json`, à la racine donnée au
serveur (`--racine`, sinon le dossier servi) :

```json
{
  "batches": [
    {
      "id": "a1b2c3d4",
      "sentAt": "2026-09-04T14:22:10.000Z",
      "page": "/tarifs",
      "fichier": "tarifs/index.html",
      "status": "pending",
      "comments": [
        {
          "n": 1,
          "message": "remplace cette photo par celle-là",
          "target": {
            "selector": "main > section:nth-of-type(2) > div > img",
            "tag": "img",
            "classes": "rounded-xl object-cover",
            "text": "",
            "component": null,
            "source": null,
            "srcFile": null
          },
          "attachments": [".overlay/attachments/1757-a1b2-photo.png"]
        }
      ]
    }
  ]
}
```

`fichier` n'existe qu'en mode statique : c'est le fichier HTML qui a servi `page`. En mode
proxy, il vaut `null` : le code se retrouve par `srcFile`, les classes ou le texte.

Les images jointes vont dans `.overlay/attachments/`. Le dossier `.overlay/` entier est à
ignorer dans le git du site : ce sont des annotations de travail, pas une livraison.

## Les statuts d'un lot

| Statut | Qui l'écrit | Ce que l'overlay en fait |
|---|---|---|
| `pending` | le serveur, à la réception | **la comète tourne** autour de la barre : « Envoyé · Claude arrive… » |
| `en_cours` | **Claude, dès son réveil, avant de travailler** | la comète s'arrête : « Claude a pris la main » |
| `done` | Claude, une fois appliqué | rien de plus |

L'overlay interroge `GET /__overlay/statut` toutes les 1,5 s tant qu'un lot est `pending`.
Passer le lot à `en_cours` est donc la première chose à faire à chaque réveil : dix
secondes sans réponse ressemblent à une panne.

Une pastille se clique : le commentaire se rouvre, texte et images en place, pour être
corrigé ou retiré. Sur écran tactile, le doigt posé surligne et le relâchement sélectionne :
il n'y a pas de survol à émuler.

## Le watcher

Outil `Monitor`, `persistent: true`, depuis le dossier du site :

```bash
F=".overlay/comments.json"
prev="none"; [ -f "$F" ] && prev=$(stat -c %Y "$F")
while true; do
  cur="none"; [ -f "$F" ] && cur=$(stat -c %Y "$F")
  if [ "$cur" != "$prev" ]; then echo "OVERLAY: nouveau lot de commentaires"; prev="$cur"; fi
  sleep 2
done
```

Une ligne émise = un lot envoyé. Lire le fichier, traiter les lots `pending`, les passer à
`done`. Cette écriture réveille le watcher une fois à vide : normal.

## Le serveur

| Mode | Commande | Ce qu'il fait |
|---|---|---|
| statique | `--dossier <site>` | sert les fichiers, injecte dans les `.html`, note `fichier` dans chaque lot |
| proxy | `--proxy http://localhost:3000 --racine <projet>` | relaie HTTP et WebSockets vers le serveur de dev, injecte dans les réponses HTML |

Dans les deux modes : `/__overlay/overlay.js` et `/__overlay/synchro.js` servent les
scripts, `/__overlay/ping` répond `{ ok, mode, racine }`. Port 4400 par défaut, décalé
automatiquement s'il est pris : **lire `OVERLAY_URL=` dans la sortie**.

Chaque page reçoit `synchro.js`, puis `overlay.js`, dans cet ordre. Sur un projet
`/buildyoursite` (reconnu à `components/buildyoursite/overlay.tsx` sous `--racine`), seul
`synchro.js` est injecté : le site rend déjà son propre overlay, après l'hydratation, et notre
script arriverait trop tôt pour le voir. `--sans-overlay` force le même comportement.

## Les téléphones

`scripts/telephones.mjs --url <OVERLAY_URL>` ouvre deux fenêtres Electron transparentes et
sans cadre : on ne voit que l'appareil. Chacune dessine le boîtier en HTML
(`scripts/telephones/telephone.html`) et place dans l'écran une vue native qui charge le site
à travers le serveur d'overlay.

| Ce qui fait le téléphone | Comment |
|---|---|
| Taille réelle, au millimètre | `telephones/ecrans.ps1` lit la taille physique de chaque écran dans son EDID (WMI, sans droits d'administrateur) ; l'échelle vaut 0,166 mm par point multiplié par les pixels par millimètre de l'écran où se trouve le téléphone, et se recalcule quand on le pose sur un autre écran |
| Fenêtre exacte (402 × 766, 440 × 848 px CSS) | la page voit la taille de la vue divisée par le zoom, arrondie vers le bas : `calage()` cherche une largeur et une hauteur entières, et un zoom au milieu de l'intervalle où les deux divisions tombent juste. Chaque téléphone a sa session, pour que le zoom ne se partage pas |
| Hauteur visible | écran moins la barre d'état (54 pt) et la barre de Safari réduite (54 pt) : 766 et 848 px |
| Place à l'ouverture | à côté de la fenêtre de Claude (trouvée par `ecrans.ps1`), sur le premier écran où ils tiennent sans la couvrir ; ensuite, la dernière place choisie, retenue dans `~/.claude/overlay/telephones.json` |
| Poignée | déplacement par script : la page signale début, mouvements et fin, le moteur lit le curseur et déplace la fenêtre |
| Tactile, sans survol | réglages du moteur : `touch-events` et `blink-settings` (pointeur grossier, survol absent) |
| Agent utilisateur | Safari sur iPhone, suivi du marqueur `OverlayTelephone/` |
| Barre d'état | `theme-color` du site, sinon la couleur du haut de la page ; encre blanche ou noire selon la luminance |
| Boîtier, boutons, île | `scripts/telephones/appareils.json`, en points, d'après les fiches Apple |

**La synchronisation.** Dans la fenêtre principale, `synchro.js` publie sur
`POST /__overlay/synchro` deux sortes de messages : `page` (adresse, et un identifiant de
chargement qui change à chaque rechargement) et `defilement`. Les téléphones, reconnus à leur
agent utilisateur, s'abonnent à `GET /__overlay/synchro` (flux continu). Le serveur garde le
dernier de chaque : un téléphone qui arrive se cale aussitôt. `GET /__overlay/synchro/etat`
montre ce qu'il garde et combien de téléphones écoutent.

**L'état du navigateur.** Troisième message, `stockage`. La fenêtre principale envoie son
localStorage quand il change (valeurs de plus de 32 Ko exclues) ; le serveur y joint les
cookies lus dans l'entête `Cookie` de chacun de ses envois, HttpOnly compris, et diffuse
`{ type: "stockage", cookies, local, version }` quand l'un ou l'autre change. Le téléphone
recopie cookies et clés, efface ceux qui venaient de la fenêtre principale et n'y sont plus,
et se recharge si un changement se voit. Ne comptent pas : les clés des outils de mesure
d'audience (`_ga`, `_fbp`, `ph_`…), celles du serveur de développement (`__next`), et un
changement qui ne porte que sur de longues suites de chiffres (horodatage). La version
appliquée est notée dans le sessionStorage du téléphone : une même version ne recharge
jamais deux fois. `/__overlay/synchro/etat` liste les noms des cookies et des clés, jamais
leurs valeurs.

**Les gestes.** Quatre messages de plus, transmis et oubliés (un vieux clic rejoué à un
téléphone qui arrive refermerait ce qui est ouvert) : `clic`, `saisie`, `touche`,
`defilement-element`. Seulement les vrais gestes (`isTrusted`), hors de l'interface
d'édition et hors du mode Édition (`buildyoursite:mode` ou `overlay:mode` à `edition` dans
le sessionStorage). L'élément visé est le plus proche ancêtre qui réagit au clic ; il est
décrit par sa balise, ses attributs stables, son texte, son rang parmi ses semblables et son
chemin depuis `<body>`. Le téléphone le retrouve par le chemin si rien n'a bougé, sinon par
le rang. Le clic porte l'état d'avant (coché, `open` d'un `<details>`, `aria-expanded`,
`aria-selected`, `data-state`), lu dès l'appui : le téléphone ne touche que s'il est dans le
même. Le toucher rejoué suit l'ordre d'un iPhone : `pointerdown`, `touchstart`, `pointerup`,
`touchend`, puis `mousedown`, `mouseup`, `click`, sauf si la page annule `touchend`. Les
liens qui naviguent ne sont pas rejoués : la page suit déjà.

**Les envois.** En mode proxy, une requête qui modifie (tout sauf GET, HEAD, OPTIONS) venue
de la fenêtre principale garde sa réponse quinze secondes. La même requête venue d'un
téléphone (même méthode, même adresse, même `Next-Action`) reçoit cette réponse, une fois
par téléphone, sans atteindre le site ; arrivée pendant que le site répond, elle l'attend.
Les téléphones se distinguent par leur nom, à la fin de leur agent utilisateur.

**Le hasard.** Chaque page reçoit, juste après `<head>`, un `Math.random` à graine qui
s'efface aussitôt exécuté : resté dans la page, il prenait la place du premier script du
site à l'hydratation de React, et Next signalait une erreur. Un chargement de page de la
fenêtre principale tire une graine neuve ; les téléphones reçoivent la même. Le tirage
repart de l'adresse après une navigation sans rechargement (`__overlayHasard`).

**Le défilement ne passe pas en pourcentage.** Une section deux fois plus haute sur téléphone
fausserait tout. On envoie un repère : l'élément en haut de l'écran et le suivant (sections,
titres, paragraphes, images, dans l'ordre du document), avec la fraction parcourue entre les
deux. Le téléphone retrouve les deux mêmes éléments dans sa mise en page et se place entre eux.
Il les reconnaît à leur place et à leur balise ; le texte ne sert qu'à départager quand un
élément n'existe que sur un écran. Les éléments fixes ou collants sont écartés, sinon
l'en-tête serait toujours « en haut ».

**Dans un téléphone**, `synchro.js` lève le drapeau qui empêche `overlay.js` de se monter, et
masque l'overlay d'un projet `/buildyoursite`. Le badge de développement de Next et la barre
de défilement de Chrome sont masqués aussi : le téléphone montre le site tel qu'un visiteur
le verrait.

**Ce que le moteur refuse, appris en le construisant :**
- toute commande d'émulation d'appareil dans une vue intégrée fait planter Electron 44, sans
  message ; d'où la largeur obtenue par la taille de la vue et le zoom ;
- un chemin Windows passé en argument séparé (`--option C:/…`) fait échouer son démarrage :
  tous les arguments passent en `--option=valeur` ;
- l'application Claude est elle-même un Electron : le lanceur retire `ELECTRON_RUN_AS_NODE`
  de l'environnement, sinon le moteur démarrerait comme un simple Node, sans fenêtre ;
- la zone de glisser de Windows (`-webkit-app-region: drag`) ne reçoit pas le survol : dans
  une fenêtre qui laisse passer les clics hors de l'appareil, elle ne s'activait jamais ;
- une seconde instance qui appelle `app.quit()` devient prête quand même et ouvre ses
  téléphones avant de partir : elle sort par `app.exit(0)` ;
- le niveau `floating` de `setAlwaysOnTop` range la fenêtre derrière la barre des tâches ;
  une capture d'écran qui déplace la barre lui fait perdre son premier plan. Niveau
  `pop-up-menu`, et une veille chaque seconde.

Un point par pixel, comme dans la première version, donnait des téléphones une fois et demie
à deux fois trop grands : un point d'iPhone mesure 0,166 mm, un pixel de moniteur entre 0,2
et 0,3. D'où la mesure physique des écrans.

Le serveur retire les entêtes et balises `Content-Security-Policy` des pages qu'il sert :
sans ça, un site un peu strict bloquerait le script injecté. C'est local et temporaire ; ne
pas reporter dans le site.
