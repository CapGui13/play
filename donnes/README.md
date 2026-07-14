# Bibliothèque de donnes du club

Ce dossier contient des fichiers `.pbn`/`.lin` mis à disposition de tous les hôtes de
partie dans **Table d'enchères**, en plus de la possibilité d'uploader son propre fichier
depuis l'appareil utilisé. Dans le salon d'attente, l'hôte les retrouve dans un menu
déroulant "Piocher dans la bibliothèque du club", à côté du champ d'upload habituel.

## Ajouter une donne à la bibliothèque

1. Dépose le fichier `.pbn` ou `.lin` dans ce dossier (`donnes/`).
2. Pousse-le sur GitHub comme le reste du site (`git add`, `git commit`, `git push`).

C'est tout — `catalogue.json` n'est plus à éditer à la main : le workflow
`.github/workflows/deploy.yml` le régénère à chaque déploiement en listant simplement les
`.pbn`/`.lin` réellement présents dans ce dossier (voir l'étape "Régénérer
donnes/catalogue.json").

Le nom du fichier tel que déposé ici est directement celui affiché dans le menu déroulant
de l'appli : choisis des noms clairs (`coupe-provence-2026.pbn` plutôt que
`export_final_v3.pbn`).

## Retirer une donne

Supprime le fichier de ce dossier et pousse — il disparaîtra du menu déroulant au
déploiement suivant, `catalogue.json` étant reconstruit à partir du contenu réel du
dossier à chaque fois.

## Pourquoi `catalogue.json` existe s'il n'est plus édité à la main ?

GitHub Pages ne sert que des fichiers statiques : il n'y a rien côté serveur capable de
lister le contenu d'un dossier à la volée une fois le site en ligne. `catalogue.json` joue
ce rôle — mais c'est désormais le workflow de déploiement qui le génère automatiquement
(en listant `donnes/` au moment du build), pas un fichier à tenir à jour à la main. Le
fichier présent dans le dépôt Git peut donc être obsolète entre deux déploiements (utile
seulement pour un test en local hors du pipeline GitHub Actions) — c'est celui régénéré au
moment du build qui est réellement servi aux joueurs.

## ⚠️ Ne pas oublier après avoir ajouté/retiré une donne

L'appli fonctionne aussi hors-ligne grâce à un service worker qui met en cache tout ce
qu'il a déjà chargé — y compris `catalogue.json` et les fichiers de ce dossier. Un joueur
ayant déjà ouvert l'appli continuera donc de voir l'**ancienne** bibliothèque tant que le
cache n'est pas invalidé. Rien à faire à la main pour ça : pousser sur GitHub suffit, le
workflow `.github/workflows/deploy.yml` s'occupe de forcer la mise à jour du cache chez
tout le monde à chaque déploiement (voir le README principal).
