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

C'est la phase d'édition du skill `buildyoursite`, extraite pour servir seule : sur
n'importe quel site, quel que soit son framework, sans toucher à son code. Les deux
s'installent séparément et ne dépendent pas l'un de l'autre.

**Et deux iPhones flottent à côté.** Un iPhone 17 et un iPhone 17 Pro Max, boîtier et
boutons compris, posés sur le bureau au-dessus des autres fenêtres. Chacun affiche la même
page avec la fenêtre exacte du téléphone, et suit la vôtre : vous faites défiler, ils
défilent ; vous changez de page, ils changent ; Claude modifie le code, ils se mettent à jour
en direct. Vous modifiez toujours dans la fenêtre principale ; les téléphones montrent le
rendu mobile. Une poignée en haut à droite de chacun permet de le déplacer où vous voulez.

---

## Démarrage rapide

**1.** Dans Claude Code, deux commandes :

```
/plugin marketplace add juliengastal11-dot/overlay
```

```
/plugin install overlay@overlay
```

**2.** Redémarrez Claude Code. Les skills sont recensés au lancement.

**3.** Ouvrez-le dans le dossier de votre site et tapez `/overlay`.

Il faut **Node 20 ou plus** et le panneau navigateur de Claude Code. Le serveur et l'overlay
n'utilisent que la bibliothèque standard de Node. Les téléphones, eux, ont besoin d'Electron :
le skill l'installe tout seul à la première ouverture, environ 120 Mo à télécharger, une seule
fois, dans `~/.claude/overlay/moteur`.

---

## Ce qu'il faut savoir

**Il faut les fichiers.** Une URL est une image du site, pas son code. Le skill commence donc
par obtenir un dossier : un chemin local, un dépôt à cloner, ou, si le site vous appartient
et que vous n'avez que l'adresse, une copie téléchargée. Une copie est du HTML rendu, pas
la source : parfaite pour un site statique ou un WordPress, un squelette pour un site généré
en JavaScript. Le skill vous le dit.

**Il refuse le site d'un tiers.** La première question, quand vous donnez une URL, est
« ce site vous appartient-il ? ». Sinon, il ne copie rien.

**Il ne déploie rien.** Ce que vous faites des modifications vous appartient.

## Comment ça marche

Un petit serveur local sert votre site (directement pour un dossier statique, en proxy
devant le serveur de dev pour un projet Next, Vite, Astro…) et injecte l'overlay dans chaque
page HTML. Le site ne sait pas qu'il est observé ; rien n'est ajouté à son code. Les
commentaires arrivent dans `.overlay/comments.json`, un watcher réveille Claude.

| | |
|---|---|
| `SKILL.md` | Le comportement : obtenir les fichiers, afficher, éditer |
| `scripts/serveur-overlay.mjs` | Le serveur : statique ou proxy, avec injection |
| `scripts/overlay.js` | L'overlay, en JavaScript pur, sans dépendance |
| `scripts/synchro.js` | Ce qui relie votre fenêtre aux téléphones |
| `scripts/telephones.mjs` | Les deux iPhones flottants |
| `scripts/telephones/` | Leur boîtier, leur fiche technique, leur moteur |
| `scripts/miroir.mjs` | La copie locale d'un site qui vous appartient |
| `references/mecanique.md` | Format des commentaires, watcher, serveur, téléphones |

## Prérequis

Node 20 ou plus, et Claude Code avec son panneau navigateur. Le serveur et l'overlay
n'utilisent que la bibliothèque standard de Node. Les téléphones installent Electron à leur
première ouverture, une seule fois.

Les téléphones sont rendus par le moteur de Chrome, réglé sur l'iPhone : la mise en page, les
points de rupture et le comportement tactile sont ceux du téléphone, le rendu des polices est
celui de l'ordinateur. Pour une validation finale, un vrai iPhone reste la référence.

## Installation

Depuis Claude Code, sans quitter le terminal :

```
/plugin marketplace add juliengastal11-dot/overlay
```

```
/plugin install overlay@overlay
```

Ou à la main :

```bash
git clone https://github.com/juliengastal11-dot/overlay ~/.claude/skills/overlay
```

Sous Windows, le dossier des skills est `%USERPROFILE%\.claude\skills\overlay`.

Dans les deux cas, redémarrez Claude Code, ouvrez-le dans le dossier de votre site, et
tapez `/overlay`. Le moteur des téléphones s'installe de lui-même à la première ouverture.

## Licence

MIT. Voir [LICENSE](LICENSE).
