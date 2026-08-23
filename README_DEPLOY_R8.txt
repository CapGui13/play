PLAY R8 — mise à jour rapide après recette R7

Remplacer UNIQUEMENT dans le dépôt PLAY :
- app.js
- sw.js

Aucun changement API-gen n'est requis pour R8.

Correctifs :
- nouvel invité différé => donne 1 ;
- reconnexion d'un joueur différé => conserve sa donne locale ;
- reconnexion de l'hôte => ne retire plus les flèches des invités différés.

Après push GitHub Pages : fermer complètement les anciens onglets PLAY puis rouvrir.
