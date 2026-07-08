# Table d'enchères — Bridge à distance

Application web statique permettant à 2, 3 ou 4 joueurs, chacun sur son propre écran, de
s'entraîner aux enchères en temps réel sur des donnes importées (fichier `.pbn` ou `.lin`
exporté depuis le générateur de donnes).

Aucun serveur : la connexion entre les navigateurs se fait directement en pair-à-pair
(WebRTC, via le service public gratuit PeerJS pour la mise en relation initiale, et un
relais TURN gratuit en secours si la connexion directe échoue). Le site peut donc être
hébergé gratuitement sur GitHub Pages.

## Modes de jeu

À la création d'une partie, l'hôte choisit un mode :

| Mode | Joueurs | Répartition |
|---|---|---|
| **Binôme** | 2 | Hôte = Nord ou Sud (à son choix), invité = l'autre siège. Est-Ouest est joué par un robot qui passe systématiquement — utile pour s'entraîner à son système d'enchères sans interférence adverse. |
| **Diagonale** | 2 | Hôte = Sud+Ouest ou Nord+Est (à son choix), invité = la paire complémentaire. |
| **Maître du jeu** | 3 | Hôte = Est+Ouest ("maître du jeu"), 2 invités = Nord et Sud. Seul l'hôte peut recommencer l'enchère ou passer à la donne suivante. |
| **4 joueurs** | 4 | Hôte = Nord, 3 invités = Est, Sud, Ouest (dans l'ordre de connexion). Chacun ne voit que sa propre main. |

Dans tous les modes, chaque joueur ne voit que les mains qu'il contrôle, et la boîte
d'enchères n'autorise que les annonces légales, uniquement quand c'est son tour.

## Déploiement sur GitHub Pages

1. Crée un nouveau dépôt GitHub (ou utilise un dépôt existant).
2. Place-y les fichiers de ce dossier (`index.html`, `styles.css`, `app.js`,
   `bidding-rules.js`, `deal-parser.js`, `peer-connection.js`) à la racine.
3. Pousse-les :
   ```
   git init
   git add .
   git commit -m "Table d'enchères"
   git branch -M main
   git remote add origin https://github.com/<ton-compte>/<ton-depot>.git
   git push -u origin main
   ```
4. Sur GitHub : **Settings → Pages → Source : Deploy from a branch**, choisis la branche
   `main` et le dossier `/ (root)`, puis **Save**.
5. Après une minute ou deux, le site est accessible à
   `https://<ton-compte>.github.io/<ton-depot>/`.

Aucune clé, aucun compte externe à configurer : tout fonctionne dès la mise en ligne.

## Utilisation

**L'hôte (celui qui crée la partie)** :
1. Ouvre le site, choisit un **mode de jeu**, clique sur **"Créer une partie"**.
2. Un code à 4 lettres apparaît (et un lien à partager, qui contient déjà le code).
3. Partage ce code ou ce lien au(x) autre(s) joueur(s).
4. Une fois que tous les invités attendus sont connectés (1, 2 ou 3 selon le mode),
   choisis le fichier `.pbn` ou `.lin` à charger et, si le mode le propose, ton siège,
   puis clique sur **"Commencer la partie"**.

**Les invités** :
1. Ouvrent le lien partagé (le code est alors pré-rempli), ou saisissent le code
   manuellement sur l'écran d'accueil, puis cliquent sur **"Rejoindre"**.
2. Une fois la partie démarrée par l'hôte, la table apparaît automatiquement, avec le(s)
   siège(s) qui leur a/ont été attribué(s).

**Pendant la partie** :
- Chaque joueur ne voit que les mains qu'il contrôle (une ou deux selon le mode).
- La boîte d'enchères n'autorise que les annonces légales, et seulement quand c'est
  votre tour.
- Une fois l'enchère terminée (3 passes après une annonce, ou 4 passes d'entrée), le
  contrat final s'affiche, avec un bouton pour passer à la donne suivante.
- Le bouton **"Recommencer l'enchère"** relance l'enchère de la donne en cours. En mode
  "Maître du jeu", seul l'hôte peut recommencer l'enchère ou passer à la donne suivante.

## Limites connues

- **Connexion directe (WebRTC)** : fonctionne dans l'immense majorité des cas grâce au
  relais TURN de secours, mais la mise en relation initiale peut occasionnellement
  prendre jusqu'à une trentaine de secondes sur certains réseaux.
- Tous les joueurs doivent être en ligne **en même temps** pour établir la connexion.
  Si l'un d'eux ferme son onglet, il faut recréer une partie (nouveau code).
- Seule la phase d'**enchères** est couverte (pas le jeu de la carte).
- Le fichier de donnes n'est chargé que par l'hôte ; les invités le reçoivent
  automatiquement via la connexion, ils n'ont rien à importer de leur côté.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (écrans accueil / attente / jeu) |
| `styles.css` | Habillage visuel |
| `bidding-rules.js` | Logique pure des enchères (légalité des annonces, calcul du contrat) |
| `deal-parser.js` | Lecture des fichiers `.pbn` et `.lin` |
| `peer-connection.js` | Connexion WebRTC entre les joueurs (via PeerJS), topologie en étoile pour les modes à 3+ joueurs |
| `app.js` | État de l'application, modes de jeu, attribution des sièges, et rendu de l'interface |
