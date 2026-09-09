---
name: overlay
description: Ouvre un site existant dans le panneau navigateur avec l'overlay d'édition visuelle (survol, clic, bulle de commentaire, pastilles numérotées, barre Navigation/Édition) puis applique les modifications demandées dans le code. Déclenché par /overlay suivi d'une URL ou d'un dossier, ou quand l'utilisateur veut éditer au clic un site qu'il a déjà.
---

# /overlay

Tu ouvres un site **déjà existant** à côté du terminal et tu le fais modifier au clic. C'est la
phase 2 de `/buildyoursite`, extraite pour servir seule : sur n'importe quel site, pas
seulement ceux que le skill a construits.

## Les deux règles absolues

1. **On n'édite pas un rendu, on édite des fichiers.** Une URL seule est une image du site,
   pas son code. Avant d'afficher quoi que ce soit, tu dois avoir **un dossier sur le disque** :
   cloné, copié, ou téléchargé. Sans dossier, il n'y a rien à modifier.
2. **En phase d'édition, tes réponses font UNE ligne.** « Fait : titre en orange. » Pas de
   récapitulatif. Tu ne développes que si quelque chose casse, ou si un clic révèle un défaut
   plus large que la demande : une seconde ligne, pas plus.

## Modèle

**Sonnet 5 suffit, et c'est le bon choix par défaut.** Ce skill applique des modifications
sur un code qui existe déjà, avec un commentaire qui dit quoi changer et, le plus souvent,
le fichier visé nommé dans le lot. C'est du codage courant sur un périmètre connu : rapide,
peu coûteux, sans perte de qualité.

Repasse sur Opus 5 quand un retour demande une **décision** plutôt qu'une retouche :
concevoir une section qui manque, revoir une structure, trancher un parti pris de design.
Le critère : *est-ce que je remplace du texte et des classes, ou est-ce que je décide
quelque chose ?*

## Chemins

| | |
|---|---|
| Serveur d'overlay | `<skill>/scripts/serveur-overlay.mjs` |
| L'overlay lui-même (JS pur, injecté) | `<skill>/scripts/overlay.js` |
| Copie d'un site qui appartient à l'utilisateur | `<skill>/scripts/miroir.mjs` |
| Mécanique, format des commentaires, watcher | `<skill>/references/mecanique.md` |

`<skill>` est le dossier de base annoncé au lancement. Ne le code jamais en dur.

Un site cloné ou copié atterrit **dans le dossier où la session est ouverte**, dans un
sous-dossier à son nom. Jamais ailleurs : les outils de Claude Code sont autorisés dans ce
dossier et demandent une permission à chaque écriture en dehors. Propose le chemin, laisse
l'utilisateur refuser.

---

## Phase 0 : Obtenir les fichiers

Lis ce que l'utilisateur t'a donné après `/overlay`.

### Un dossier local

Regarde ce qu'il contient, et choisis le mode :

| Ce que tu trouves | Mode | Commande |
|---|---|---|
| `package.json` avec `next` | proxy sur son serveur de dev | `npx next dev -p 3000`, puis `--proxy http://localhost:3000` |
| `package.json` avec un autre framework (Vite, Astro, SvelteKit…) | proxy | `npm run dev`, **lis le port dans sa sortie**, puis `--proxy` |
| `index.html` sans `package.json` | statique | `--dossier <chemin>` |
| Rien de tout ça | demande | — |

Un projet construit par `/buildyoursite` porte déjà son overlay : `/overlay` n'y ajoute rien
(le script détecte l'existant et ne se monte pas deux fois). Lance simplement son serveur de
dev et ouvre-le.

**Mais vérifie son âge d'abord.** Un site emporte une copie de l'overlay au moment de sa
construction ; celle-ci ne se met jamais à jour toute seule. Si `/buildyoursite` est
installé :

```bash
node "~/.claude/skills/buildyoursite/scripts/mettre-a-jour-overlay.mjs" . --verifier
```

S'il annonce des fichiers différents, relance sans `--verifier` et recharge la page. Sans ce
contrôle, l'utilisateur retrouve l'overlay du jour où son site est né, et te dit à juste
titre que rien n'a changé.

Si `/buildyoursite` n'est pas installé, tu ne peux pas mettre l'overlay du projet à niveau :
c'est le sien qui s'affiche, et il fonctionne. Dis-le en une ligne plutôt que de laisser
croire à une panne.

### Un dépôt git

Clone-le dans `racineProjets/<nom>`, puis traite-le comme un dossier local.

### Une URL de site en ligne

C'est le cas qui demande le plus de soin, parce que **c'est là qu'on peut se tromper de
site à modifier**. Pose deux questions, avant tout autre geste :

> **Ce site t'appartient-il ?**
> - *Oui* → on continue
> - *Non* → tu t'arrêtes là : « Je peux l'ouvrir dans le panneau pour le regarder, mais je ne
>   copie pas le site d'un tiers. » Ne présente pas d'autre option.

> **Où sont ses fichiers ?**
> - *Un dépôt git* → il donne l'URL, tu clones
> - *Un dossier sur cette machine* → il donne le chemin
> - *Je n'ai que l'adresse* → tu en fais une copie :

```bash
node "<skill>/scripts/miroir.mjs" --url https://son-site.fr --sortie "<racineProjets>/<nom>"
```

**Dis-lui ce qu'est une copie.** Le miroir télécharge les pages rendues, les feuilles de
style, les scripts et les images. C'est du HTML figé, pas la source. Sur un site généré côté
navigateur (React, Wix, Framer, Webflow avec JS), la copie est un squelette : le script te le
signale, et l'édition devra alors passer par la vraie source ou l'outil d'origine. Sur un site
statique ou WordPress rendu côté serveur, la copie s'édite très bien.

Ce qu'il fait des modifications ensuite (remettre en ligne, reporter dans son outil) lui
appartient. Tu ne déploies rien.

## Phase 1 : Afficher

1. **Point de restauration.** Si le dossier n'est pas un dépôt git : `git init`, puis un
   premier commit `overlay: état initial`. Sans ça, « reviens en arrière » est impossible. Si
   `git config user.email` est vide, pose l'identité en local depuis `gitNom` / `gitEmail` du
   `config.json` de `/buildyoursite` s'il est installé, sinon demande-la en une ligne.
   Ajoute `.overlay/` au `.gitignore` du site : les commentaires ne sont pas une livraison.

2. **Lance le serveur d'overlay**, depuis le dossier du site :

   ```bash
   node "<skill>/scripts/serveur-overlay.mjs" --dossier .            # site statique
   node "<skill>/scripts/serveur-overlay.mjs" --proxy http://localhost:3000 --racine .   # framework
   ```

   Il injecte `overlay.js` dans chaque page HTML qu'il sert, reçoit les commentaires sur
   `/__overlay/comments` et les écrit dans `.overlay/comments.json`. **Lis la ligne
   `OVERLAY_URL=…` qu'il affiche** (il se décale de port tout seul si 4400 est pris) et
   ne suppose jamais l'adresse.

   En mode proxy, il relaie aussi les WebSockets : le rechargement à chaud du framework
   continue de fonctionner à travers lui.

3. **Ouvre `OVERLAY_URL` dans le panneau navigateur** (`preview_start` avec `url`). Regarde
   qu'il s'affiche, et que la barre en bas à droite est là. Si elle n'y est pas : la page
   n'est pas du HTML servi par le serveur (une application qui rend tout en JS depuis un
   `index.html` vide l'est quand même : la barre apparaît).

4. **Arme le watcher**, outil `Monitor`, `persistent: true`, depuis le dossier du site :

   ```bash
   F=".overlay/comments.json"
   prev="none"; [ -f "$F" ] && prev=$(stat -c %Y "$F")
   while true; do
     cur="none"; [ -f "$F" ] && cur=$(stat -c %Y "$F")
     if [ "$cur" != "$prev" ]; then echo "OVERLAY: nouveau lot de commentaires"; prev="$cur"; fi
     sleep 2
   done
   ```

   `description` : `commentaires overlay <nom du site>`.

5. Rends la main en **deux lignes** : l'URL, et « bascule la barre sur Édition et clique sur
   ce que tu veux changer ».

## Phase 2 : Éditer

Le watcher te réveille à chaque lot. Alors :

1. Lis `.overlay/comments.json`, prends les lots `pending` **et passe-les tout de suite à
   `en_cours`**, avant de lire quoi que ce soit. C'est ce qui arrête la comète de l'overlay
   et dit à l'utilisateur que tu as vu.
2. Commit de sécurité.
3. Applique **tous** les commentaires du lot.
4. Vérifie : `npx tsc --noEmit` sur un projet TypeScript, sinon recharge la page dans le
   panneau et regarde. Cassé → corrige avant de répondre.
5. Passe les lots à `done`. Le watcher persistant reste armé ; ton écriture le réveille une
   fois à vide, c'est normal.
6. Réponds **en une ligne**.

Commentaire ambigu : prends la lecture la plus probable et applique-la. Il corrigera d'un
autre clic, c'est plus rapide qu'une question.

### Retrouver le code visé

Chaque commentaire porte une cible. Dans l'ordre d'utilité :

1. **`fichier`** : en mode statique, le serveur note **quel fichier HTML a servi la page**.
   C'est direct : le code est là.
2. **`srcFile`** : si le site vient de `/buildyoursite`, le `data-src` de l'ancêtre le plus
   proche donne le fichier source.
3. **`classes`** puis **`text`** : un `Grep` sur la liste de classes ou sur le texte visible
   tombe sur la bonne ligne dans un projet framework. Cherche dans le dossier des
   composants d'abord, jamais dans `node_modules` ni dans un dossier de build.
4. **`selector`** : le chemin DOM, pour départager deux éléments identiques.

Sur une copie miroir, le fichier est le HTML lui-même : les styles sont soit dans une feuille
`.css` du dossier, soit en ligne. Modifie ce que tu trouves, ne réécris pas la page.

## Pièges connus

**Une entête `Content-Security-Policy` bloquerait le script injecté.** Le serveur la retire
des réponses HTML : en local, pour l'édition, jamais ailleurs. Ne reporte pas cette
suppression dans le site.

**En mode Édition, les clics sont interceptés** : la page ne navigue plus. Pour changer de
page, l'utilisateur repasse en Navigation (ou `Alt+E`). Si son commentaire dit « sur la page
tarifs » alors que le lot vient de `/`, c'est qu'il a cliqué avant de naviguer : le champ
`page` du lot fait foi pour le fichier, son texte pour l'intention.

**Un miroir ne se recharge pas à chaud.** Après une modification d'un site statique, recharge
la page dans le panneau (`navigate` sur la même URL). Le serveur lit le disque à chaque
requête, rien à relancer.

**Le port 3000 déjà pris par un autre projet.** Next bascule en silence sur 3001 et tu
proxifierais le mauvais site. Lis toujours le port dans la sortie du serveur de dev avant de
lancer le proxy.

**Les journaux réseau sont des historiques, pas des états.** Avant de conclure à un bug,
refais l'appel.

## Ce que tu ne fais pas

Aucun déploiement, aucune mise en ligne, aucune copie d'un site qui n'appartient pas à
l'utilisateur.
