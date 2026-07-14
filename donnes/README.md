# Bibliothèque de donnes du club

Ce dossier contient des fichiers `.pbn`/`.lin` mis à disposition de tous les hôtes de
partie dans **Table d'enchères**, en plus de la possibilité d'uploader son propre fichier
depuis l'appareil utilisé. Dans le salon d'attente, l'hôte les retrouve dans un menu
déroulant "Piocher dans la bibliothèque du club", à côté du champ d'upload habituel.

## Ajouter une donne à la bibliothèque

1. Dépose le fichier `.pbn` ou `.lin` dans ce dossier (`donnes/`).
2. Ajoute son nom exact (avec l'extension) dans `catalogue.json`, qui est un simple
   tableau de noms de fichiers :
   ```json
   [
       "coupe-provence-2026-huitiemes.pbn",
       "entrainement-chelems.pbn"
   ]
   ```
3. Pousse les deux fichiers sur GitHub comme le reste du site (`git add`, `git commit`,
   `git push`) — pas de build, pas d'étape supplémentaire.

Le nom de fichier tel qu'il apparaît dans `catalogue.json` est directement celui affiché
dans le menu déroulant de l'appli : choisis des noms clairs (`coupe-provence-2026.pbn`
plutôt que `export_final_v3.pbn`).

## Retirer une donne

Retire son nom de `catalogue.json` (le fichier peut rester dans le dossier ou être
supprimé, au choix — seul `catalogue.json` détermine ce qui apparaît dans le menu).

## Pourquoi un fichier JSON à la main plutôt qu'une vraie liste automatique ?

GitHub Pages ne sert que des fichiers statiques : il n'y a rien côté serveur capable de
lister le contenu d'un dossier à la volée. `catalogue.json` joue ce rôle à la main —
volontairement simple, sans étape de build, cohérent avec le reste du projet (aucune
dépendance, aucun compte externe à configurer).

## ⚠️ Ne pas oublier après avoir ajouté/retiré une donne

L'appli fonctionne aussi hors-ligne grâce à un service worker qui met en cache tout ce
qu'il a déjà chargé — y compris `catalogue.json` et les fichiers de ce dossier. Un joueur
ayant déjà ouvert l'appli continuera donc de voir l'**ancienne** bibliothèque tant que le
cache n'est pas invalidé. Après toute modification ici, incrémente `CACHE_NAME` dans
`sw.js` à la racine du repo (voir le README principal) pour que tout le monde voie la mise
à jour.
