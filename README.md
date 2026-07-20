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

## Corrections diverses (voir échange avec Guillaume)

- **Avertissement contraintes obsolètes** : modifier un champ de contraintes après avoir
  généré affiche un rappel ("cliquez de nouveau sur Générer") plutôt que de laisser croire
  que les donnes déjà générées reflètent les derniers réglages — rien ne se régénère
  automatiquement, comme pour les deux autres sources (fichier, bibliothèque).
- **Wizz sur iPhone** : le tremblement anime maintenant `.app-container` plutôt que
  `<body>` directement — iOS Safari n'applique pas de façon fiable une animation
  `transform` posée sur `<body>` (lié à sa gestion du scroll/de la barre d'URL).
- **Rôles d'undo inversés** : un ancien cas spécial pour l'hôte annulait toujours la toute
  dernière case du tableau d'enchères, quel qu'en soit l'auteur — si un robot passait
  automatiquement juste après l'annonce de l'hôte (avant qu'il clique "undo"), l'hôte
  annulait ce passe robot au lieu de sa propre annonce, ce qui faussait le calcul de qui
  doit valider (parfois personne, parfois la mauvaise personne). Retiré ce cas spécial :
  hôte et invités suivent maintenant exactement la même logique (retrouver la dernière
  annonce parmi les sièges qu'on contrôle soi-même, pas juste la dernière case du tableau).

## Contraintes optionnelles pour les donnes aléatoires

Le bouton "⚙️ Contraintes avancées" (repliable, sous le générateur de donnes aléatoires)
permet de régler, pour chacun des 4 sièges indépendamment (voir échange avec Guillaume) :
- une fourchette de points H (min et/ou max) ;
- une longueur minimale dans une couleur choisie (ex. "Sud a 5+ cartes à Pique").

Et pour chaque ligne (Nord-Sud, Est-Ouest) :
- une fourchette de points H combinés (ex. "NS a 24+ à eux deux").

Toutes ces contraintes sont optionnelles et cumulables (un champ vide = pas de contrainte
sur ce point) ; elles s'ajoutent à la contrainte fixe déjà existante (12H+ dans toute
ligne occupée par 2 humains). Si des fourchettes trop serrées empêchent de satisfaire
toutes les contraintes simultanément après 500 tentatives, la donne est générée quand même
(mieux vaut ça qu'un blocage) et un avertissement s'affiche précisant combien de donnes
n'ont pas pu toutes les respecter.

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

**Corrections supplémentaires suite à un nouveau test de la donne 2** (voir échange avec
Guillaume) :
- **Routage en séquence compétitive** : quand un adversaire reparle après l'annonce du
  partenaire (typique en séquence compétitive à 4), le moteur cherchait auparavant
  uniquement la toute dernière annonce de l'enchère pour savoir "qui répond à qui" — donc
  un joueur pouvait se retrouver à tort à "intervenir" sur l'adversaire au lieu de
  répondre/soutenir son propre partenaire, ou l'ouvreur à tort privé de son rebid. Corrigé
  en recherchant l'annonce du partenaire en remontant l'historique plutôt qu'en ne
  regardant que la dernière.
- **Points de soutien** : quand la longueur de la couleur du partenaire est GARANTIE (5+
  via une majeure/intervention, 3+ par défaut à la mineure), les décisions de soutien
  comptent maintenant les points de soutien plutôt que HL — H bruts + 2 points si le 9ème
  atout du camp est atteint (ma longueur + le minimum garanti du partenaire) + la valeur
  des courtes dans les AUTRES couleurs (chicane +5, singleton +3, doubleton +1). Utilisé à
  la fois par le soutien mineur et l'échelle des soutiens majeurs.
- **Contre d'appel exclu avec une longue couleur** : 6+ cartes dans une même couleur se
  montrent directement plutôt que de se cacher derrière un contre, qui ne promet de
  longueur nulle part et gâcherait une belle couleur.

**Corrections supplémentaires suite aux donnes 5 et 7** (voir échange avec Guillaume) :
- **Réponse en changement de couleur toujours forcing** : généralisé au-delà du seul 2/1
  (palier 2 sur majeure) — une réponse en NOUVELLE couleur, palier 1 ou 2, n'est jamais
  limitée par nature, donc l'ouvreur reparle systématiquement, quels que soient ses
  points (donne 5 : l'ouvreur à 13HL montre bien sa 2e couleur maintenant). Reste borné à
  UN SEUL rebid de l'ouvreur — la suite complète du répondant (4ème couleur forcing,
  donne 5) reste hors périmètre : généraliser aussi cette suite produisait des sous-enchères
  incorrectes sur les mains fortes en test, signe que ça demande une vraie logique dédiée
  plutôt qu'une simple extension.
- **Palier de soutien manquant au-delà de 15 points** : l'échelle des soutiens directs à
  une majeure s'arrêtait à 15HLD (3SA), laissant une main de 16+ points de soutien
  retomber sur un repli générique invitant seulement (palier 3) — alors que la manche est
  déjà acquise. Ajout d'un palier "16+ HLD → manche directe" (donne 7).

**Suite du répondant en zone de manche connue** (voir échange avec Guillaume, retour sur
la donne 5) : ma première tentative (une heuristique de longueur de fit maison) ne
correspondait pas à ce qu'il avait demandé — remplacée par sa règle réelle, plus simple :
une ouverture à la couleur promet 12+, donc un répondant ayant lui-même 12+ sait que son
camp a 24+ à eux deux et doit continuer jusqu'à la manche. Priorité systématique à un fit
MAJEUR de 8+ cartes *connu* (la couleur d'ouverture promet 5+ si majeure, un rebid en
nouvelle couleur promet 4+) ; à défaut, manche à SA directement, sans explorer un fit
mineur. Ne considère que les couleurs déjà montrées par l'OUVREUR, pas une éventuelle
longue du répondant lui-même chez qui elle n'a pas été explicitement demandée — un
raffinement possible si besoin.

**Corrections supplémentaires suite aux donnes 5 et 6, encore affinées** (voir échange
avec Guillaume) :
- **Pas de rebid forcé si un adversaire est intervenu** : la règle "reparle toujours après
  une nouvelle couleur" ne s'applique que si personne d'autre n'a parlé depuis — une fois
  la concurrence entrée en jeu (adversaire intervenu entre la réponse du partenaire et mon
  tour), ce n'est plus vraiment forcing, l'ouvreur peut légitimement passer (donne 6 :
  Est n'a plus à reparler après l'intervention de Nord). La loi des atouts et le filet
  18HL+ restent inchangés, eux.
- **Reverse (bicolore cher)** : une 2e couleur qui EXIGE le palier 2 pour être annoncée
  ET qui rang plus haut que l'ouverture (donc le partenaire devrait monter d'un cran pour
  revenir à la 1ère couleur) promet 17HL+ — pas juste "une couleur plus chère" en
  général. Un bicolore économique montrable au palier 1 (donne 5 : 1♣ puis 1♠, le
  partenaire ayant répondu 1♥) n'est jamais un reverse, quel que soit le rang des
  couleurs — ma première version de cette règle comparait les rangs sans vérifier le
  palier réellement nécessaire, cassant à tort la donne 5 en la corrigeant.

**Correction critique sur la donne 7** (voir échange avec Guillaume) : j'avais mal compris
le sens d'un saut direct à la manche en soutien — ça ne montre PAS une main forte, mais
l'inverse (barrage, main faible et distribuée avec 5+ atouts, déjà couvert plus haut dans
l'échelle). Une main VRAIMENT forte (16+ points de soutien) doit au contraire **différer**
: annoncer une nouvelle couleur (la plus longue des 3 autres si 4+ cartes, sinon la plus
courte comme relais faute de mieux) pour forcer l'ouvreur à reparler, puis confirmer le
fit à la manche une fois la suite en zone de manche connue déclenchée (voir
decideResponderContinuationAfterNewSuit, corrigé au passage pour viser directement la
manche plutôt que le palier minimal légal, qui sous-vendait aussi la main).

**Correction sur la donne 8** (voir échange avec Guillaume) : une réponse en nouvelle
couleur sur un barrage du partenaire est déjà forcing un tour — pas besoin de sauter pour
montrer une main forte (le saut, lui, aurait un tout autre sens : splinter). Retiré le
saut que j'avais ajouté à tort, et déplacé la décision du bon côté : c'est l'OUVREUR du
barrage qui juge, à son rebid, s'il pousse à la manche — avec un fit (3+ cartes) et une
main en haut de sa fourchette (8-12HL, zone haute = 11HL+), il pousse directement à la
manche dans la couleur du partenaire ; sinon il répète sa propre couleur. Logique dédiée
aux ouvertures de barrage (palier 2+), distincte de la logique des ouvertures naturelles
au palier 1.

**Barrage en intervention** (voir échange avec Guillaume, précision sémantique importante
— c'est une intervention sur l'adversaire, pas une réponse au partenaire) : même forme
qu'un barrage d'ouverture (8-12HL, 6+ cartes dans une seule couleur, rien d'autre à
montrer) mais en intervention — saut direct au palier 2 plutôt qu'une intervention
naturelle au palier minimal, qui sous-décrit une main concentrée dans une longue sans
valeur défensive ailleurs.

## Nouvelle relecture de session (voir échange avec Guillaume)

Trois corrections supplémentaires, chacune trouvée en creusant au-delà du symptôme initial :

- **Longue avant majeure 4ème en zone de manche** : la priorité "majeure avant tout" ne
  vaut que pour une main limitée qui cherche un fit rapide en un seul tour. Avec 12+
  (zone de manche connue, plusieurs tours possibles) et une couleur de 5+ cartes plus
  longue que la majeure trouvée, on montre la longue d'abord — plus informatif qu'une
  majeure 4ème qui ne dit rien sur la vraie forme de la main.
- **Le fit prime sur une 2e couleur perso** : au rebid de l'ouvreur après une réponse en
  changement de couleur, indiquer qu'on est fitté (4+ cartes chez soi pour la couleur du
  partenaire — un simple 3 ne suffit pas, une réponse ne garantissant que 4+ chez le
  partenaire) passe avant de chercher à montrer sa propre 2e couleur. Mêmes zones que les
  ouvertures : 12-14H soutien simple, 15-17H invite, 18H+ manche directe.
- **Réponse au contre malgré une intervention adverse, et suite du contreur** : comme pour
  les enchères normales, répondre au contre d'appel du partenaire reste possible même si
  un adversaire a reparlé depuis (ça "libère" formellement l'obligation, sans l'empêcher).
  Ajout de la suite du CONTREUR lui-même : avec de la réserve au-delà du minimum du contre
  (15H+) et un fit pour la couleur choisie par le partenaire, il pousse directement à la
  manche plutôt que de laisser filer un partiel.

## Corrections issues de la session du 20 juillet (voir échange avec Guillaume)

Trois retours après relecture d'une nouvelle session, chacun corrigé après une analyse
précise (donne 3 en particulier a d'abord été mal comprise — confusion entre intervention
et réponse au sein d'un même camp, corrigée après clarification) :

- **Contre d'appel exclu avec une majeure 5ème** : comme pour une couleur de 6+ cartes
  (correction précédente), une majeure de 5 cartes suffit à préférer une intervention
  naturelle à un contre d'appel — assez descriptive en elle-même pour ne pas se cacher
  derrière un contre.
- **Contre adverse = intervention pour la règle du rebid forcé** : un contre de la couleur
  du partenaire (pas seulement une vraie annonce) libère maintenant l'ouvreur de
  l'obligation de reparler après une réponse en changement de couleur — la situation est
  tout aussi compétitive qu'une nouvelle enchère adverse.
- **Répéter une mineure au palier 2+ doit rester honnête** : ça ne montre plus une simple
  main de 4 cartes minimum — seulement 6+ cartes, ou 5 cartes avec une chicane/singleton
  ailleurs (cas moins fréquent). Sans ces conditions, et sans autre option, l'ouvreur passe
  plutôt que de sur-décrire sa main. Ne s'applique pas à une majeure, qui promet déjà 5+
  dès l'ouverture.
- **2♣ fort artificiel (22-23HL équilibrée)** : un "super 2SA" annoncé en deux temps —
  2♣ (forcing), le répondant relaie systématiquement en 2♦ (pas de réponse positive par
  couleur, volontairement hors périmètre), puis l'ouvreur précise 22-23 en rebiddant 2SA.
  Le répondant, dont le relais initial ne disait rien de sa main, l'évalue alors pour la
  première fois (même logique de seuil qu'une réponse à une ouverture de 2SA normale) —
  avec une majeure 5+ franche, la manche s'y joue directement plutôt qu'à SA.
- **Seuil de réponse à un barrage relevé (donne 3)** : le seuil de 11HL pour montrer une
  nouvelle couleur était le même qu'après une ouverture normale (qui promet déjà 12+) —
  mais un barrage plafonne le partenaire à 8-12HL, donc 11HL n'offre "aucun espoir de
  manche" même dans le meilleur des cas. Relevé à 13HL (pour la nouvelle couleur ET le
  repli SA) spécifiquement en réponse à un barrage — pile de quoi espérer la manche même
  si le partenaire n'a que le minimum de sa fourchette. Le soutien direct du barrage
  lui-même (sans nouvelle couleur) n'est pas concerné : soutenir reste une action
  compétitive raisonnable même avec des points modestes.

## Corrections issues d'une relecture de session (voir échange avec Guillaume)

Après une session de test, Guillaume a exporté le fichier et relu chaque donne en détail
— plusieurs corrections concrètes en ont découlé :

- **Réponse "up the line"** : avec les deux majeures à 4 cartes en réponse à une ouverture
  à la mineure, Cœur est annoncé avant Pique (le moins cher d'abord, pour garder la main
  de montrer Pique ensuite sans se fermer d'options) — l'ordre était inversé.
- **"1SA poubelle"** : avec une main plate et un fit d'exactement 3 cartes à une mineure
  qui n'a jamais promis 5+ (donc via une ouverture, pas une intervention), 1SA naturel
  est préféré à un soutien direct qui engagerait sur un fit marginal.
- **2/1 forcing de manche** : une réponse en changement de couleur au palier 2 sur une
  ouverture d'1 majeure est désormais reconnue comme forcing de manche — l'ouvreur
  reparle TOUJOURS (pas seulement à 18HL+) : répète sa couleur ou montre un bicolore
  économique (4+ cartes) en zone 1 (12-14H), ou en zone 2+ irrégulière ; 2SA avec 15H+ et
  une répartition exactement 5332. Le répondant enchérit une deuxième fois lui aussi :
  fit avec l'ouverture (3+ cartes) ou le rebid (4+, seuil plus exigeant qu'une couleur
  déjà confirmée), sinon 3SA par défaut.
- **Loi des atouts** : avec 6+ cartes dans sa couleur d'ouverture et un soutien confirmé
  du partenaire (fit connu de 9+ cartes), l'ouvreur repousse d'un palier indépendamment
  de ses points d'honneur — la sécurité distributionnelle prime.
- **Réponse plus ferme face à un barrage** : avec une vraie main forte (13H+) en réponse
  à un "2 faible" du partenaire, un saut au-delà du palier naturel montre l'excédent
  plutôt qu'une simple couleur au minimum, qui ressemblerait à une main limitée.

**Mis de côté pour l'instant**, signalés explicitement plutôt qu'ignorés silencieusement :
4ème couleur forcing complet (exigerait plusieurs enchères par camp au-delà du cas 2/1
borné ci-dessus, risque de casser la terminaison sans une refonte plus large), points
Kaplan-Rubens (pas de formule fournie), contre "toute distribution" et séquences
compétitives détaillées après contre (trop pointu pour une première passe), repli 1SA en
quatrième position (ambigu sur les conditions exactes de déclenchement).

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
