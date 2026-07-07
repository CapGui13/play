# Table d'enchères — Bridge à distance

Application web statique permettant à deux joueurs, chacun sur son propre écran, de
s'entraîner aux enchères en temps réel sur des donnes importées (fichier `.pbn` ou `.lin`
exporté depuis le générateur de donnes).

Aucun serveur : la connexion entre les deux navigateurs se fait directement en pair-à-pair
(WebRTC, via le service public gratuit PeerJS pour la mise en relation initiale). Le site
peut donc être hébergé gratuitement sur GitHub Pages.

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

**Le premier joueur (hôte)** :
1. Ouvre le site, clique sur **"Créer une partie"**.
2. Un code à 4 lettres apparaît (et un lien à partager, qui contient déjà le code).
3. Partage ce code ou ce lien au deuxième joueur (message, chat, etc.).
4. Une fois que l'autre joueur est connecté, choisis le fichier `.pbn` ou `.lin` à
   charger et ton camp (Nord-Sud ou Est-Ouest), puis clique sur **"Commencer la partie"**.

**Le deuxième joueur** :
1. Ouvre le lien partagé (le code est alors pré-rempli), ou saisis le code manuellement
   sur l'écran d'accueil, puis clique sur **"Rejoindre"**.
2. Une fois la partie démarrée par l'hôte, la table apparaît automatiquement.

**Pendant la partie** :
- Chaque joueur ne voit que les deux mains de son camp (Nord+Sud, ou Est+Ouest) —
  comme lors d'un vrai entraînement d'enchères en partenariat.
- La boîte d'enchères n'autorise que les annonces légales, et seulement quand c'est
  votre tour.
- Une fois l'enchère terminée (3 passes après une annonce, ou 4 passes d'entrée), le
  contrat final s'affiche, avec un bouton pour passer à la donne suivante.
- Le bouton **"Recommencer l'enchère"** relance l'enchère de la donne en cours pour les
  deux joueurs (utile après une erreur).

## Limites connues

- **Connexion directe (WebRTC)** : fonctionne dans l'immense majorité des cas, mais peut
  échouer si l'un des deux joueurs est derrière un réseau très restrictif (certains
  Wi-Fi d'entreprise, VPN). Si la connexion échoue systématiquement, réessayer depuis un
  autre réseau (4G, Wi-Fi personnel) résout généralement le problème.
- Les deux joueurs doivent être en ligne **en même temps** pour établir la connexion.
  Si l'un des deux ferme son onglet, il faut recréer une partie (nouveau code).
- Seule la phase d'**enchères** est couverte (pas le jeu de la carte).
- Le fichier de donnes n'est chargé que par l'hôte ; l'invité le reçoit automatiquement
  via la connexion, il n'a rien à importer de son côté.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (écrans accueil / attente / jeu) |
| `styles.css` | Habillage visuel |
| `bidding-rules.js` | Logique pure des enchères (légalité des annonces, calcul du contrat) |
| `deal-parser.js` | Lecture des fichiers `.pbn` et `.lin` |
| `peer-connection.js` | Connexion WebRTC entre les deux navigateurs (via PeerJS) |
| `app.js` | État de l'application et rendu de l'interface |
