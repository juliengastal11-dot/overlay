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

Dans les deux modes : `/__overlay/overlay.js` sert le script, `/__overlay/ping` répond
`{ ok, mode, racine }`. Port 4400 par défaut, décalé automatiquement s'il est pris :
**lire `OVERLAY_URL=` dans la sortie**.

Le serveur retire les entêtes et balises `Content-Security-Policy` des pages qu'il sert :
sans ça, un site un peu strict bloquerait le script injecté. C'est local et temporaire ; ne
pas reporter dans le site.
