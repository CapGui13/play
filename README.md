# Table d'enchères — Bridge à distance

Application web statique permettant de 2 à 4 joueurs, chacun sur son propre écran, de
s'entraîner aux enchères en temps réel sur des donnes importées (fichier `.pbn` ou `.lin`
exporté depuis le générateur de donnes).

Aucun serveur : la connexion entre les navigateurs se fait directement en pair-à-pair
(WebRTC, via le service public gratuit PeerJS pour la mise en relation initiale, et un
relais TURN gratuit en secours si la connexion directe échoue). Le site peut donc être
hébergé gratuitement sur GitHub Pages.

## Composition libre de la table

Il n'y a pas de "modes" figés : l'hôte crée une partie, atterrit dans un **salon
d'attente**, et voit apparaître chaque participant au fil de leur connexion (avec un
pseudo par défaut du style "Guest #2", que chacun peut changer — le changement se
répercute immédiatement chez tout le monde).

Dans ce salon, l'hôte assigne librement chacun des 4 sièges (Nord/Est/Sud/Ouest) à
n'importe quel participant présent — y compris **la même personne sur deux sièges**, et y
compris lui-même. Un siège non assigné est automatiquement joué par un robot qui passe
systématiquement. Cette seule mécanique permet de reproduire toutes les configurations :

- **2 joueurs, binôme** : un invité et l'hôte sur Nord et Sud, Est-Ouest laissés vides (robot).
- **2 joueurs, diagonale** : l'hôte sur Sud+Ouest, l'invité sur Nord+Est (ou l'inverse).
- **3 joueurs, "maître du jeu"** : l'hôte sur Est **et** Ouest, deux invités sur Nord et Sud.
- **4 joueurs** : chacun un seul siège.
- Toute autre combinaison qui a du sens pour vous.

Une fois la table composée, l'hôte charge le fichier de donnes et lance la partie ; chaque
participant reçoit alors uniquement la ou les mains qu'on lui a assignées.

## Déploiement sur GitHub Pages

1. Crée un nouveau dépôt GitHub (ou utilise un dépôt existant).
2. Place-y les fichiers de ce dossier (`index.html`, `styles.css`, `app.js`,
   `bidding-rules.js`, `deal-parser.js`, `peer-connection.js`, `manifest.json`, `sw.js`,
   le dossier `icons/`, le dossier `donnes/`) à la racine.
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
1. Ouvre le site, clique sur **"Créer une partie"** → atterrit dans le salon.
2. Un code à 4 lettres apparaît (et un lien à partager, qui contient déjà le code, et
   rejoint automatiquement la partie une fois ouvert).
3. Partage ce code ou ce lien aux autres joueurs.
4. Au fil de leur connexion, chacun apparaît dans la liste des participants du salon.
5. L'hôte assigne chacun à un ou plusieurs sièges via les menus déroulants Nord/Est/Sud/Ouest
   (un siège laissé sur "— (robot : passe)" sera joué automatiquement).
6. L'hôte choisit le fichier `.pbn` ou `.lin` à charger, puis clique sur
   **"Commencer la partie"**.

**Les invités** :
1. Ouvrent le lien partagé (rejoint automatiquement), ou saisissent le code manuellement
   sur l'écran d'accueil puis cliquent sur **"Rejoindre"**.
2. Arrivent dans le même salon, où ils peuvent changer leur pseudo (visible par tous en
   temps réel) et voir la composition de la table se dessiner au fur et à mesure.
3. Une fois que l'hôte lance la partie, la table de jeu apparaît automatiquement, avec
   le(s) siège(s) qui leur a/ont été attribué(s).

**Pendant la partie** :
- Chaque joueur ne voit que les mains qu'il contrôle (une ou deux). Sans siège assigné, on
  suit la partie en **kibbitzer** : les 4 mains sont visibles dès le début de la donne.
  Quand on contrôle plusieurs sièges (mode "maître du jeu" ou diagonale), celle dont c'est
  le tour est mise en valeur (halo doré, léger balayage lumineux) et les autres grisées,
  pour repérer d'un coup d'œil laquelle demande une action.
- La boîte d'enchères n'autorise que les annonces légales, et seulement quand c'est
  votre tour.
- Une fois l'enchère terminée (3 passes après une annonce, ou 4 passes d'entrée), le
  contrat final s'affiche, avec un bouton pour passer à la donne suivante.
- Le bouton **"Recommencer l'enchère"** relance l'enchère de la donne en cours. Seuls les
  joueurs actifs (assignés à au moins un siège) peuvent recommencer l'enchère ou changer
  de donne ; un kibbitzer ne peut que regarder.
- Le bouton **"Demander un undo"** propose d'annuler la dernière annonce (utile en cas de
  mauvais clic). Si l'équipe adverse compte un humain, elle doit accepter ou refuser ; si
  elle n'est faite que de robots (ou si vous jouez les deux camps), l'annulation est
  immédiate.
- Les flèches **◀ ▶** à côté du numéro de donne permettent à l'hôte de sauter à la donne
  précédente ou suivante à tout moment (même en pleine enchère), sans attendre la fin de
  l'enchère en cours. Seul l'hôte les voit ; les autres joueurs continuent d'utiliser le
  bouton "Donne suivante →" qui n'apparaît qu'une fois l'enchère terminée.

## Limites connues

- **Connexion directe (WebRTC)** : fonctionne dans l'immense majorité des cas grâce au
  relais TURN de secours, mais la mise en relation initiale peut occasionnellement
  prendre jusqu'à une trentaine de secondes sur certains réseaux.
- Tous les joueurs doivent être en ligne **en même temps** pour établir la connexion
  initiale, mais une coupure en cours de partie n'est plus fatale (voir "Reconnexion"
  ci-dessous).
- Seule la phase d'**enchères** est couverte (pas le jeu de la carte).
- Le fichier de donnes n'est chargé que par l'hôte ; les invités le reçoivent
  automatiquement via la connexion, ils n'ont rien à importer de leur côté.

## Reconnexion

Chaque invité porte un petit jeton généré dans son navigateur (conservé via
`localStorage` — survit à la fermeture de l'onglet et à un redémarrage du navigateur,
tant que c'est le même appareil). Si sa connexion tombe — Wi-Fi qui coupe, ordinateur qui
se met en veille, onglet qui plante — l'hôte garde sa place et son ou ses sièges
réservés. **Son siège n'est pas remplacé par un robot** : l'enchère patiente simplement
que ce joueur revienne, avec un indicateur qui le signale clairement ("🔌 En attente que
X se reconnecte...").

Pour revenir :
- **En rechargeant simplement la page** (ou en rouvrant le lien de partage, même dans un
  nouvel onglet) : la reconnexion et la reprise de la partie en cours (donne, enchère,
  sièges) sont automatiques.
- **Sans recharger** : un bouton **"🔌 Se reconnecter"** apparaît dans la barre du haut
  dès que la connexion est perdue ; un clic suffit pour reprendre exactement où on en
  était.

Limites connues :
- Ceci ne couvre que la reconnexion d'un **invité**. Si c'est l'**hôte** qui part, la
  partie ne peut pas reprendre (son identifiant de connexion change à chaque nouvelle
  partie) — il faudra recréer une partie et repartager un nouveau code.
- Deux onglets ouverts sur la même partie, dans le même navigateur, partagent le même
  jeton — sans conséquence pour un usage normal (un onglet par joueur), mais à éviter si
  vous testez seul avec plusieurs onglets pour simuler plusieurs joueurs.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (accueil / salon / jeu) |
| `styles.css` | Habillage visuel |
| `bidding-rules.js` | Logique pure des enchères (légalité des annonces, calcul du contrat) |
| `deal-parser.js` | Lecture des fichiers `.pbn` et `.lin` |
| `peer-connection.js` | Connexion WebRTC entre les joueurs (via PeerJS), topologie en étoile pour 3+ joueurs |
| `app.js` | État de l'application, salon (pseudos, assignation des sièges), et rendu de l'interface |
| `manifest.json` | Manifeste PWA (nom, icônes, couleurs, mode plein écran) |
| `sw.js` | Service worker : cache hors-ligne des fichiers ci-dessus, gère les mises à jour |
| `icons/` | Icônes PWA (180/192/512px) référencées par `manifest.json` et `index.html` |
| `donnes/` | Bibliothèque de donnes du club, piochable depuis le salon d'attente (voir `donnes/README.md`) |

## PWA — installation sur mobile

Le site est installable ("Ajouter à l'écran d'accueil") sur iOS et Android, et fonctionne
hors-ligne pour tout ce qui ne dépend pas du réseau (interface, règles d'enchères).
Aucune configuration : le navigateur détecte `manifest.json` et propose l'installation
automatiquement (Android), ou l'utilisateur passe par Partager → Sur l'écran d'accueil
(iOS — l'appli affiche une invite dédiée la première fois).

**Mise à jour du cache : automatique, via GitHub Actions.** `sw.js` gère l'invalidation du
cache via la constante `CACHE_NAME` en tête de fichier, mais elle n'est plus à incrémenter
à la main : le workflow `.github/workflows/deploy.yml` la réécrit tout seul à chaque push
sur `main`, avec un identifiant dérivé du commit (`bridge-encheres-<sha>`), avant de
déployer. Chaque déploiement a donc forcément un `CACHE_NAME` différent du précédent, et
le service worker détecte toujours la mise à jour — la bannière "Nouvelle version
disponible" s'affiche automatiquement chez les joueurs ayant déjà installé l'appli ; il
leur suffit de cliquer "Recharger". Ça vaut aussi pour `donnes/catalogue.json` et les
fichiers de `donnes/`, mis en cache dès leur premier chargement bien que non listés dans
`CORE_ASSETS` (voir `donnes/README.md`).

Prérequis pour que ce workflow s'exécute : **Settings → Pages → Source** doit être réglé
sur *"GitHub Actions"* (pas *"Deploy from a branch"*). Après un `git push`, l'onglet
**Actions** du dépôt montre le déploiement en cours puis son statut.
