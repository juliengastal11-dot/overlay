# overlay

Un skill Claude Code qui ouvre un site **que vous avez déjà** à côté du terminal, et vous
laisse le modifier **en cliquant dessus**.

```
/overlay C:\Sites\mon-site
/overlay https://github.com/vous/mon-site
/overlay https://mon-site.fr
```

Survol : la zone se surligne. Clic : elle se fige et une bulle s'ouvre. Vous écrivez ce que
vous voulez changer, vous pouvez joindre une image, vous validez. Les commentaires s'empilent
avec une pastille numérotée, puis partent en lot. Claude se réveille et applique dans le code.

C'est la phase d'édition du skill `buildyoursite`, extraite pour servir seule — sur
n'importe quel site, quel que soit son framework, sans toucher à son code. Les deux
s'installent séparément et ne dépendent pas l'un de l'autre.

## Ce qu'il faut savoir

**Il faut les fichiers.** Une URL est une image du site, pas son code. Le skill commence donc
par obtenir un dossier : un chemin local, un dépôt à cloner, ou — si le site vous appartient
et que vous n'avez que l'adresse — une copie téléchargée. Une copie est du HTML rendu, pas
la source : parfaite pour un site statique ou un WordPress, un squelette pour un site généré
en JavaScript. Le skill vous le dit.

**Il refuse le site d'un tiers.** La première question, quand vous donnez une URL, est
« ce site vous appartient-il ? ». Sinon, il ne copie rien.

**Il ne déploie rien.** Ce que vous faites des modifications vous appartient.

## Comment ça marche

Un petit serveur local sert votre site — directement pour un dossier statique, en proxy
devant le serveur de dev pour un projet Next, Vite, Astro… — et injecte l'overlay dans chaque
page HTML. Le site ne sait pas qu'il est observé ; rien n'est ajouté à son code. Les
commentaires arrivent dans `.overlay/comments.json`, un watcher réveille Claude.

| | |
|---|---|
| `SKILL.md` | Le comportement : obtenir les fichiers, afficher, éditer |
| `scripts/serveur-overlay.mjs` | Le serveur — statique ou proxy, avec injection |
| `scripts/overlay.js` | L'overlay, en JavaScript pur, sans dépendance |
| `scripts/miroir.mjs` | La copie locale d'un site qui vous appartient |
| `references/mecanique.md` | Format des commentaires, watcher, détails du serveur |

## Prérequis

Node 20 ou plus, et Claude Code avec son panneau navigateur. Aucune dépendance à installer :
le serveur et l'overlay n'utilisent que la bibliothèque standard de Node.

## Installation

```bash
git clone https://github.com/juliengastal11-dot/overlay ~/.claude/skills/overlay
```

C'est tout. Ouvrez Claude Code dans le dossier de votre site et tapez `/overlay`.

Sous Windows, le dossier des skills est `%USERPROFILE%\.claude\skills\overlay`.

## Licence

MIT — voir [LICENSE](LICENSE).
