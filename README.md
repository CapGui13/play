# Table d'enchères — Bridge à distance

Application web statique permettant de 2 à 4 joueurs, chacun sur son propre écran, de
s'entraîner aux enchères en temps réel sur des donnes importées (fichier `.pbn` ou `.lin`
exporté depuis le générateur de donnes).

Aucun serveur : la connexion entre les navigateurs se fait directement en pair-à-pair
(WebRTC, via le service public gratuit PeerJS pour la mise en relation initiale, et deux
relais TURN gratuits et indépendants en secours si la connexion directe échoue — voir
`ICE_CONFIG` dans `peer-connection.js`). Le site peut donc être hébergé gratuitement sur
GitHub Pages.

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
   (un siège laissé sur "— (robot)" sera joué automatiquement — voir "Enchères automatiques
   des robots" plus bas).
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
  suit la partie en **kibbitz** : les 4 mains sont visibles dès le début de la donne.
  Quand on contrôle plusieurs sièges (mode "maître du jeu" ou diagonale), celle dont c'est
  le tour est mise en valeur (halo doré, léger balayage lumineux) et les autres grisées,
  pour repérer d'un coup d'œil laquelle demande une action.
- La boîte d'enchères n'autorise que les annonces légales, et seulement quand c'est
  votre tour.
- Une fois l'enchère terminée (3 passes après une annonce, ou 4 passes d'entrée), le
  contrat final s'affiche, avec un bouton pour passer à la donne suivante.
- Le bouton **"Recommencer l'enchère"** relance l'enchère de la donne en cours. Seuls les
  joueurs actifs (assignés à au moins un siège) peuvent recommencer l'enchère ou changer
  de donne ; un kibbitz ne peut que regarder.
- Le bouton **"Demander un undo"** propose d'annuler la dernière annonce (utile en cas de
  mauvais clic). Si l'équipe adverse compte un humain, elle doit accepter ou refuser ; si
  elle n'est faite que de robots (ou si vous jouez les deux camps), l'annulation est
  immédiate.
- Les flèches **◀ ▶** à côté du numéro de donne permettent à l'hôte de sauter à la donne
  précédente ou suivante à tout moment (même en pleine enchère), sans attendre la fin de
  l'enchère en cours. Seul l'hôte les voit ; les autres joueurs continuent d'utiliser le
  bouton "Donne suivante →" qui n'apparaît qu'une fois l'enchère terminée.

## Navigation entre les donnes

Chaque donne garde sa propre enchère (`deals[i].auctionHistory`) au lieu d'une seule
variable de travail écrasée à chaque changement de donne : revenir sur une donne déjà
jouée réaffiche son enchère et son contrat tels quels, plutôt que de repartir de zéro.

**Export de session** (voir échange avec Guillaume) : le bouton "📦 Exporter la session"
(en-tête de l'écran de jeu, à côté d'Undo/Recommencer) télécharge un fichier PBN
regroupant toutes les donnes dont l'enchère est terminée — mains, enchère réellement
menée, vulnérabilité — pour donner un retour précis sur une session ("donne 2, Sud a
contré mais..."). Un fichier PBN standard accepte nativement plusieurs donnes à la suite,
donc réutilise directement `buildPlayedDealPBN` (déjà utilisé par l'export d'une seule
donne) pour chacune. Contrairement à l'export d'une seule donne, aucun serveur n'est
impliqué ici : téléchargement direct dans le navigateur, disponible à l'hôte comme à tout
joueur assis (à la différence de l'export unitaire, réservé à l'hôte puisque lui seul
écrit sur le repo GitHub).

## Enchères automatiques des robots

**Outil de diagnostic** : chaque annonce jouée par un robot est tapable dans le relevé
d'enchères (petit point discret sur la case) et affiche pourquoi elle a été choisie
(points H/HL calculés, branche de décision, contexte) — pratique pour repérer directement
un seuil à corriger plutôt que de décortiquer une capture d'écran.

Un siège laissé sur "— (robot)" n'ouvre plus systématiquement passe : il applique un moteur
d'enchères volontairement simplifié plutôt qu'un vrai simulateur (hors de portée
raisonnable pour ce projet — même les logiciels commerciaux s'y cassent régulièrement les
dents), avec des seuils repris du **SEF** (Système d'Enchères Français), la référence
utilisée en club — voir [le dictionnaire des enchères de bridge-chailley.fr](https://www.bridge-chailley.fr/dictionnaire-des-encheres/),
notamment sa fiche "Ouvertures", plutôt qu'une généralisation approximative :

- **Comptage en points H+L** (honneurs + longueur : +1 par carte au-delà de la 4e dans une
  couleur de 5+ cartes) pour la plupart des décisions, à l'exception explicite d'1SA
  (compté en H purs, comme le veut le SEF).
- **Ouverture** : 1SA avec 15-17H et une main équilibrée (4333, 4432 ou 5332) ; 2SA avec
  20-21HL équilibrée ; barrages faibles 8-12HL (2 à une majeure 6ème, 3 à 7 cartes, 4 à 8
  cartes) ; sinon la couleur la plus longue à partir de 12HL (règle "majeure 5ème,
  meilleure mineure" : une majeure de 4 cartes n'ouvre jamais, exception SEF du 3-3 aux
  mineures sans majeure 5e qui ouvre toujours du ♣). Passe en dessous de 12HL.
- **Réponse à l'ouverture du partenaire** : après une ouverture à la mineure, une majeure
  4+ cartes franche est montrée avant de soutenir la mineure (principe de base : chercher
  un fit à la majeure d'abord). **Soutien à une majeure** : échelle complète des soutiens
  directs, reprise du document SEF "L'expression des soutiens majeurs" (Christian Maury,
  FFB) que Guillaume a fourni :
  - 6-10HLD, fit 3 ou 4 cartes → soutien simple au palier 2
  - 11-12HLD, fit exactement 3 cartes → 2SA conventionnel (ne promet pas une main
    régulière)
  - 11-12HLD, fit 4+ cartes → soutien au palier 3, non-forcing
  - 13-15HLD, sans aucun singleton → 3SA fitté
  - 13-15HLD avec une courte (singleton/chicane) et 4+ atouts → splinter (saut double
    dans la couleur courte)
  - Barrage (5+ atouts, une courte, main faible en H) → saut direct à la manche,
    indépendamment du seuil habituel de points (loi des levées totales)

  **Soutien à une mineure** : logique plus simple (3+ cartes, un fit c'est 8 cartes à eux
  deux) — 6H si le partenaire a promis 5+ cartes (via une intervention, jamais via une
  ouverture à la mineure elle-même), sinon 6HL. Au-delà, une nouvelle couleur à partir de
  11HL (seuil SEF), sinon un repli à SA à partir de 6HL. Réponse à 1SA/2SA : manche
  directe à la majeure si 5+ cartes franches (repérage simple du fit, pas un vrai
  Stayman/Texas), sinon 3SA (jamais 4SA — bug corrigé à l'audit) dès 10HL après 1SA, ou
  seulement 4HL après 2SA (l'ouverture promet déjà beaucoup plus de points).
- **Rebid de l'ouvreur** (voir échange avec Guillaume) : une main d'ouverture nettement
  excédentaire (18HL+) peut reparler UNE FOIS après la réponse du partenaire, pour éviter
  les partiels absurdes (22H qui passent sur une réponse minimale). Volontairement très
  borné pour ne jamais compromettre la terminaison de l'enchère : un seul rebid par
  donne, jamais de contrôle ni de Blackwood — juste une visée directe de la manche si un
  fit est confirmé, ou une montée dans la couleur du partenaire si elle lui convient.
  N'implémente pas les "vrais" soutiens différés du document (fit montré à un deuxième
  tour) ni les enchères d'essai/de contrôle — hors de portée de ce filet ciblé.
- **Intervention sur l'ouverture d'un adversaire** : **contre d'appel** si la main s'y
  prête (12HL+, courte dans la couleur adverse — 0-2 cartes —, support raisonnable dans
  les 3 autres), sinon une intervention naturelle (5+ cartes, HL ajusté par vulnérabilité —
  voir plus bas), au palier minimal légal — avec une barre plus haute (12H en H purs, 6+
  cartes) si ce palier minimal est 2 ou plus : un contre-appel forcé au-delà du palier 1
  exige davantage qu'un simple palier 1.
- **Réponse au contre du partenaire** : quasi obligatoire, dans la meilleure des 3 couleurs
  non contrées, au palier minimal légal (ou 2 avec 10HL+) — pas de main "punitive" (laisser
  le contre en place), hors périmètre.
- **Vulnérabilité** : barrages et interventions naturelles resserrés (seuil relevé de 8HL à
  10HL) quand le camp du robot est vulnérable, plus agressifs sinon — comme le vrai SEF.
- **Globalement un seul tour de dialogue** : une fois qu'un robot a annoncé quelque chose
  dans une donne, il passe systématiquement ensuite — sauf l'ouvreur avec une main très
  forte (18HL+), qui dispose d'un unique rebid après la réponse du partenaire (voir
  ci-dessus). Pas de contre-annonce après une nouvelle enchère adverse.
- **Contre d'appel (takeout) seulement** — jamais de surcontre, jamais de contre de
  pénalité, jamais de convention (Stayman, Blackwood, Roudi,
  Texas...), pas de 2♣ fort indéterminé ni de 2♦ forcing de manche (une main assez forte
  pour ça ouvre simplement au palier 1, faute d'implémenter tout un système de relais pour
  une main sur plusieurs centaines).

Chaque annonce calculée est vérifiée par les mêmes règles de légalité que celles d'un
joueur humain avant d'être jouée ; en cas de doute, le robot passe plutôt que de risquer
une annonce invalide. Testé sur 5000 enchères complètes à 4 robots (donnes aléatoires,
tout le cycle donneur/vulnérabilité) : zéro annonce illégale, zéro blocage — dont ~6,5%
avec un rebid de l'ouvreur effectivement déclenché.

**Bug important corrigé** (voir échange avec Guillaume, "les séquences s'arrêtent toujours
trop tôt") : un simple passe initial (faute de points pour ouvrir — très fréquent) comptait
à tort comme "avoir déjà parlé", rendant ce joueur muet pour le reste de la donne, incapable
de répondre normalement à son partenaire plus tard. Seule une vraie annonce (pas un passe)
épuise désormais le tour unique de dialogue.

## Limites connues

- **Connexion directe (WebRTC)** : fonctionne dans l'immense majorité des cas grâce aux
  relais TURN de secours (deux fournisseurs indépendants), mais la mise en relation
  initiale peut occasionnellement prendre jusqu'à une trentaine de secondes sur certains
  réseaux.
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
- Ceci ne couvre que la reconnexion d'un **invité**. Si c'est l'**hôte** qui part une fois
  la partie lancée, la partie ne peut pas reprendre (son identifiant de connexion change à
  chaque nouvelle partie) — il faudra recréer une partie et repartager un nouveau code.
  Dans le salon (avant le lancement), voir "Transfert d'hôte" ci-dessous, qui couvre un cas
  proche mais différent (un départ volontaire, pas une coupure).
- Deux onglets ouverts sur la même partie, dans le même navigateur, partagent le même
  jeton — sans conséquence pour un usage normal (un onglet par joueur), mais à éviter si
  vous testez seul avec plusieurs onglets pour simuler plusieurs joueurs.

## Transfert d'hôte

Dans le salon d'attente, **avant de charger les donnes**, l'hôte peut céder son rôle à
n'importe quel autre participant connecté : un bouton **"👑 Transférer l'hôte"** apparaît à
côté de son nom dans la liste des participants. Cas d'usage typique : la création de la
partie échoue sur votre propre appareil (réseau capricieux), mais fonctionne très bien
depuis le téléphone d'un ami — il crée la partie, vous le rejoignez, puis vous vous faites
transférer le rôle d'hôte pour reprendre la main (charger les donnes, composer la table).

Techniquement, un nouveau code de partie est généré pour l'occasion (PeerJS ne permet pas
de reprendre fiablement l'ancien identifiant tout de suite) : tout le monde, y compris
l'ancien hôte, rejoint automatiquement cette nouvelle salle en arrière-plan, sans rien à
resaisir — pseudos et sièges déjà assignés sont conservés.

Limites connues :
- Uniquement possible **dans le salon**, avant que la partie ait démarré.
- Le participant visé doit être connecté au moment du transfert (pas dans le cas d'une
  place réservée en attente de reconnexion).
- Sur iPhone, comme pour la création de partie (voir l'avertissement affiché dans le
  salon), ne changez pas d'application pendant les quelques secondes que prend le
  transfert — iOS pourrait couper la connexion en plein milieu.

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
déployer. Chaque déploiement a donc forcément un `CACHE_NAME` différent du précédent, et le
service worker détecte toujours la mise à jour — appliquée **automatiquement**, sans rien à
cliquer, chez les joueurs ayant déjà installé l'appli. Par sécurité, elle attend qu'aucune
salle ne soit active (ni hôte ni invité connecté à une partie, en salon ou en jeu) avant de
recharger la page toute seule — sinon elle patiente et retente régulièrement, jusqu'à ce que
ce soit le cas. Ça vaut aussi pour `donnes/catalogue.json` et les fichiers de `donnes/`, mis
en cache dès leur premier chargement bien que non listés dans `CORE_ASSETS` (voir
`donnes/README.md`).

Prérequis pour que ce workflow s'exécute : **Settings → Pages → Source** doit être réglé
sur *"GitHub Actions"* (pas *"Deploy from a branch"*). Après un `git push`, l'onglet
**Actions** du dépôt montre le déploiement en cours puis son statut.
