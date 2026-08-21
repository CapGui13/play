# Architecture P2P + relais serveur (par siège)

Document de conception — voir échange avec Guillaume (session du 12 août 2026). À lire
avant de toucher au code : ce fichier remplace l'ancienne logique d'élection automatique d'un hôte de secours
(`computeSubHostId`, `attemptSubHostTakeover`, `promoteSelfToHostAfterTakeover`,
`GUEST_TAKEOVER_GRACE_MS`) par un modèle plus simple, qui a émergé progressivement au fil
de la conversation — voir la section "Pourquoi ce document" en bas pour le raisonnement
complet qui y a mené, si besoin de contexte.

## Principe en une phrase

**Chaque siège occupé route ses messages via P2P s'il est joignable, via le relais
serveur sinon — l'hôte ne change jamais.** C'est la seule règle. Elle s'applique aussi
bien au tout premier join (siège en attente) qu'à la 10ème reconnexion en cours de
partie : ce n'est plus un cas particulier, juste la même règle appliquée en continu.

Corollaire immédiat : "mode différé" et "mode live" ne sont plus deux chemins de code
séparés (plus de `NullPeerConnection` en alternative à un vrai `BridgePeerConnection`).
Il n'y a qu'un seul mode ; le serveur est un chemin normal pour un siège donné, pas un
repli d'exception.

## État par siège, pas état global de la salle

Chaque siège occupé (`seatAssignment[seat]` pointant vers un participant, pas
`SEAT_PENDING` ni un robot) a son propre état de transport :

- **`p2p`** — connecté à l'hôte via WebRTC (`peerConn`), messages échangés en direct.
- **`server`** — pas de connexion P2P active ; ce joueur pousse/lit via
  `api/session.js` (Redis), notifié par Pusher.

Un siège en attente (`SEAT_PENDING`, personne n'a encore rejoint) est logiquement en
`server` par défaut : c'est exactement l'état "pas encore/plus joignable en P2P", pas un
troisième cas à gérer séparément.

L'hôte lui-même est toujours en P2P dès qu'il a lancé la salle (c'est lui qui l'a créée).
S'il se déconnecte, voir "Cas particulier : l'hôte hors ligne" plus bas — ce n'est PAS
symétrique au cas d'un invité déconnecté.

## Qui valide quoi (révision du rôle d'hôte)

Erreur de départ corrigée en cours de discussion : la validation d'une annonce
(`isCallLegal` + tour de jeu) ne requiert AUCUNE information privée à l'hôte — c'est une
fonction pure sur l'état public de la partie. Le mode différé le prouve déjà : un joueur
seul face à son propre appareil valide sa propre annonce, sans hôte en ligne.

**Donc : chacun valide sa propre annonce HUMAINE**, qu'il soit en `p2p` ou en `server` — pas
l'hôte à sa place. **Exception importante depuis le hardening P2 du 21 août 2026 : une
annonce ROBOT relayée par le serveur n'est plus choisie par le client.** Le participant
peut seulement provoquer l'avancement quand c'est réellement le tour d'un siège robot ;
`api/session.js` repart du snapshot Redis autoritaire et exécute la même pile PONS v2.61
côté serveur. Une annonce robot fournie dans le snapshot client est ignorée, même si elle
est légalement valide. Le rôle d'hôte se réduit à ce qu'il est déjà en pratique pour tout le
reste :
- lancer la partie, recommencer l'enchère
- réorganiser/faire tourner les sièges
- activer/désactiver les robots
- naviguer entre les donnes

Ces actions-là restent des décisions d'organisation de table, réservées à l'hôte —
`isTrueOriginalHost()` reste le bon garde-fou pour celles-ci, inchangé.

## Le vrai risque : écriture partagée pendant une période mixte

En P2P pur (comme aujourd'hui), un seul flux existe (host ↔ chacun), donc aucune course
possible : tout passe dans l'ordre, en mémoire chez l'hôte. Le jour où on mélange les
deux transports, un nouveau risque apparaît : pendant qu'un siège en P2P vient
d'enchérir (encore seulement en mémoire côté hôte, pas encore poussé au serveur), un
siège en `server` pourrait lire une version Redis pas encore à jour, croire que c'est
son tour alors que ça ne l'est plus, et enchérir quand même.

**Décision retenue (option A, voir échange avec Guillaume) : dès qu'au moins un siège
occupé est en `server`, TOUS les sièges occupés — y compris ceux restés en `p2p` —
écrivent aussi dans Redis avec le verrou de version (`expectedVersion`/409, déjà dans
`api/session.js`) avant qu'une annonce soit considérée confirmée.** Redis devient
l'arbitre commun uniquement pendant cette période mixte. Dès que tous les sièges
occupés repassent en `p2p`, on relâche cette contrainte et on retrouve la vitesse pure
P2P d'aujourd'hui (plus d'écriture Redis à chaque annonce).

Option B (chacun écrit directement dans Redis, y compris un joueur en P2P) a été
écartée : ça déplace le problème (l'hôte doit alors être notifié par Pusher pour mettre
sa propre copie à jour) sans le simplifier.

**Latence attendue** (ordres de grandeur, à mesurer une fois construit — dépend de la
région/charge réelle de Vercel/Upstash/Pusher au moment considéré) :
- Tout le monde en P2P (comportement actuel, inchangé) : ~100-200 ms.
- Période mixte, pour qu'une annonce P2P soit *confirmée* pour tout le monde : ~300-600
  ms (P2P vers l'hôte + écriture Redis avec verrou + relais P2P aux autres connectés).
- Joueur en `server` : ~200-600 ms (écriture directe + notification Pusher), inchangé
  par rapport au mode différé actuel.

Affichage **optimiste** dans tous les cas : celui qui vient d'annoncer voit son annonce
immédiatement (0 ms perçu), la confirmation serveur arrivant en arrière-plan, avec un
retour en arrière (rare, en cas de conflit de version 409) uniquement si nécessaire.

## Cas particulier : l'hôte hors ligne

Pas symétrique au cas d'un invité déconnecté, et volontairement simplifié pour cette
première version (voir échange avec Guillaume, "option b") : quand l'hôte lui-même est
hors ligne, on ne bascule PAS automatiquement l'autorité de validation vers quelqu'un
d'autre. Chaque joueur continue de valider sa propre annonce localement (rien ne change
pour la logique de jeu elle-même), mais les actions réservées à l'hôte (recommencer
l'enchère, réorganiser les sièges, lancer la donne suivante...) restent indisponibles
jusqu'à son retour — comportement déjà correct aujourd'hui pour ces actions-là,
simplement pas de "prise de relais" à construire pour ce cas précis pour l'instant.

Piste pour plus tard, non retenue au démarrage : faire remonter les annonces de l'hôte
lui-même via le relais serveur pendant son absence (comme n'importe quel autre siège),
sans jamais réélire personne — reste ouvert si le besoin se confirme une fois le reste
en place.

## Détection de présence et bascule

PeerJS n'a pas de notion de présence native. Deux minuteurs à prévoir, tous deux déjà
dans l'esprit de ce qui existe (voir `scheduleGuestAutoReconnect`) :

- **Passage `p2p` → `server`** : dès qu'une déconnexion P2P est détectée pour un siège
  (`onPeerDisconnected`/`onSignalingDisconnected` côté concerné), bascule immédiate —
  pas de délai de grâce à attendre côté jeu (contrairement à l'ancien
  `GUEST_TAKEOVER_GRACE_MS`, qui n'a plus de raison d'exister : il n'y a plus de bascule
  d'hôte à retarder, juste un routage à changer).
- **Retour `server` → `p2p`** : sondage périodique (quelques secondes) pour retenter une
  connexion P2P directe. **Hystérésis nécessaire** : exiger une connexion P2P stable
  pendant N secondes (ex. 3-5s) avant de vraiment repasser en P2P — sinon,
  risque de flip-flop incessant sur un réseau marginal (bascule server → p2p → server →
  p2p... à chaque variation de signal).

## Réconciliation au retour vers le P2P

Au moment où un siège repasse de `server` à `p2p`, il faut comparer la version Redis
connue par l'hôte (potentiellement périmée, si l'hôte n'a pas suivi le canal Pusher
pendant que ce siège était en `server`) avec la version réellement la plus récente —
**jamais un "dernier écrit gagne" naïf** (on a déjà été mordus par exactement ce genre
de bug cette session, voir la persistance de l'état après une ancienne bascule automatique).
L'hôte doit rester abonné au canal Pusher de la salle en continu, même pendant qu'il est
lui-même pleinement en P2P avec tout le monde, pour ne jamais accumuler de retard sur ce
qui se passe côté serveur pour un siège momentanément basculé.

## Les autres types de messages (pas seulement les annonces)

Chaque type de message existant a besoin de sa propre réponse à "et si ce siège est en
`server` plutôt qu'en `p2p` ?" :

| Message | Aujourd'hui (P2P) | En `server` |
|---|---|---|
| `call` humain | host valide + relaie | le joueur valide/propose sa propre annonce ; le serveur revalide tour + légalité + propriété du siège |
| `call` robot | PONS du host live + relais P2P | **PONS serveur autoritaire** ; toute valeur robot proposée par un participant est ignorée |
| `chat` | `relayIfHost` | écrit dans Redis, Pusher notifie, tout le monde relit |
| `wizz` | relais ciblé par l'hôte | probablement à dégrader silencieusement en `server` (pas de notification "instantanée" possible sans canal direct — voir la décision déjà prise de masquer la cloche en mode différé, même logique) |
| `seats-rotated` / réorganisation | `peerConn.send` | doit aussi s'écrire dans Redis pour qu'un siège en `server` le voie |
| `resync` (état complet à la connexion) | envoyé par l'hôte à la connexion P2P | remplacé par un `GET /api/session` pour un siège en `server` |

## Ce qui disparaît du code actuel

À retirer une fois la nouvelle logique en place (pas avant — voir séquençage) :
- `computeSubHostId`, `currentSubHostId`
- `scheduleSubHostTakeoverIfNeeded`, `cancelSubHostTakeoverTimer`, `attemptSubHostTakeover`
- `promoteSelfToHostAfterTakeover`
- `GUEST_TAKEOVER_GRACE_MS`, `subHostTakeoverTimer`, `subHostDisconnectDetectedAt`
- `NullPeerConnection` comme mode alternatif (la classe elle-même peut rester comme
  état "aucun siège en p2p du tout", à voir à l'implémentation)
- Toute la UI liée ("vous prenez le relais", bannière de compte à rebours 0/20s)

## Pour les tests : un simulateur "hors ligne"

Impossible de tester sérieusement les bascules sans dépendre d'un vrai Wi-Fi capricieux
à couper/rétablir à la main. Prévoir un interrupteur de debug (probablement dans le
panneau de diagnostic déjà existant) qui force artificiellement un siège donné en mode
`server` sans vraiment couper la connexion réseau — pour tester la bascule et la
réconciliation de façon reproductible.

## Séquençage proposé

1. **Ce document** (fait).
2. **[Fait — 12 août 2026]** Salle toujours créée en vraie salle P2P dès le lancement,
   même avec un siège en attente — `uiStartGameAsHost` ne bifurque plus jamais vers
   `NullPeerConnection` : la branche "mode différé" (remap d'identité vers un jeton,
   sondage périodique en remplacement du P2P) a été supprimée, il ne reste que la
   branche live. Un siège en attente reste simplement inoccupé (déjà exclu de
   `botSeats`, `SEAT_PENDING` étant une sentinelle non vide) — la revendication
   automatique à la connexion (`onGuestConnected`) et l'affichage "en attente de..."
   fonctionnaient déjà indépendamment du mode, aucun changement nécessaire là. La
   sauvegarde cloud (`saveHostGameStateToStorage` → `pushCloudGameState`) tournait déjà
   sans condition de mode, donc la reprise asynchrone de ce siège continue de
   fonctionner sans plomberie supplémentaire.
   **Volontairement laissé hors périmètre** : `uiResumeHostSession` et
   `uiResumeFromCloud` (reprise après fermeture complète de l'onglet) utilisent encore
   `NullPeerConnection` — les unifier pose la question "qui redevient l'hôte P2P au
   retour", un problème distinct à traiter séparément, pas à mélanger avec ce point
   d'entrée précis.

   **[Revu — 12 août 2026, suite à un test de Guillaume]** Ce point laissé de côté
   s'est révélé bloquant en pratique : "quand l'hôte revient [après avoir fermé sa
   fenêtre], l'invité reste marqué déconnecté... et quand l'hôte clique pour aller à
   la donne suivante, l'invité n'est pas bougé." Cause exacte — `uiResumeHostSession`
   délègue presque toujours à `uiResumeFromCloud` (dès qu'un état cloud existe pour la
   salle, ce qui est le cas en permanence depuis les étapes 3-5), et celle-ci créait
   `NullPeerConnection` pour TOUT LE MONDE sans distinction, y compris le créateur
   d'origine qui revient. Résultat : plus aucun vrai réseau P2P à rejoindre, un invité
   qui tente de se reconnecter (`attemptGuestAutoReconnect`) ne trouve plus jamais
   personne — coincé sur le relais serveur pour toujours, y compris pour ce qui n'y
   passe volontairement jamais (changement de donne, voir `gotoBoard`, qui ne diffuse
   QUE par `peerConn.send`, jamais par le cloud).

   Corrigé en distinguant enfin les deux cas que "n'importe qui peut claim" mélangeait
   jusqu'ici : SEUL le vrai créateur original (`myToken === creatorToken`) recrée
   maintenant une vraie salle P2P au retour (dans `uiResumeFromCloud`, avec repli
   propre en cas d'`unavailable-id` passager — réutilise le même schéma que
   `hardResetHostConnection`). N'importe quel AUTRE participant qui reprend une
   session différée garde `NullPeerConnection` exactement comme avant — plusieurs
   personnes pourraient reprendre au même moment depuis des appareils différents,
   une seule peut réellement détenir l'identifiant PeerJS de la salle ; pour le
   créateur en revanche, aucune ambiguïté possible. `uiResumeHostSession` a reçu le
   même correctif pour son propre repli local (chemin plus rarement emprunté, mais
   pas mort : sert quand le cloud est injoignable au moment de la reprise).
3. **[Fait (annonces uniquement) — 12 août 2026]** Routage par siège pour les
   annonces d'enchère :
   - Invité déconnecté de l'hôte en P2P → `uiMakeCall` bascule sur
     `pushCallViaServerFallback` (relit l'état serveur, rejoue et revalide l'annonce
     dessus, pousse avec verrou de version) au lieu d'abandonner. La boîte d'enchères
     (`renderBiddingBox`) ne gèle plus son propre tour pour cette seule raison.
   - Hôte : `pollCloudForUpdates` s'active désormais aussi en mode live (plus
     seulement en différé pur), mais SEULEMENT si un siège occupé est marqué
     déconnecté (`hasDisconnectedOccupiedSeat`) — tant que tout le monde reste en P2P,
     aucun coût réseau ajouté. `applyCloudUpdate` relaie en P2P (à qui reste connecté)
     les annonces nouvellement apprises via le cloud.
   - `pushCloudGameState`/`buildCloudStatePayload` élargis à n'importe quel rôle (plus
     seulement l'hôte), avec correction au passage : `roomCreatorToken`/
     `hostReconnectToken` étaient mal renseignés pour un appelant invité (auraient
     corrompu ces champs en cloud).
   - Un invité déconnecté relit aussi périodiquement l'état serveur (même minuteur que
     `scheduleGuestAutoReconnect`) pour ne pas rester figé si son tour revient avant
     qu'il ne se reconnecte vraiment.

   **[Testé et validé — 12 août 2026]** Un invité qui annonce alors qu'il est
   réellement coupé de l'hôte : l'enchère atteint l'hôte en ~1 seconde via le relais
   serveur, puis se relaie en P2P à tout le monde. Voir le journal de test complet
   dans la conversation — comportement conforme à ce qui était visé.

   **[Hardening P2 — 21 août 2026] Autorité robot déplacée côté serveur pour le relais** :
   - le PUT restreint participant ne consomme plus aucune valeur `call` provenant du client
     dès que le tour attendu appartient à un siège robot ;
   - la pile PONS v2.61 embarquée dans PLAY (WASM + Critic + Semantic + fallback canonique)
     est également embarquée dans API-gen et exécutée dans `lib/pons-server.js` ;
   - `PonsSemanticLedger` est isolé entre requêtes par sérialisation + reconstruction de la
     branche avant chaque calcul, afin d'éviter toute contamination inter-salles ;
   - après une annonce humaine relayée, le serveur enchaîne lui-même les robots consécutifs
     jusqu'au prochain siège humain ou à la fin de l'enchère ;
   - en reprise différée, un client sans capacité d'écriture host délègue son tour robot au
     serveur au lieu d'exécuter PONS localement comme autorité ;
   - si PONS serveur ne peut pas s'initialiser ou produit une décision invalide, l'écriture
     échoue fermée (`503`) : jamais de repli sur une annonce robot fournie par le client.

   **[Fait — 12 août 2026] Chat et changements de sièges via le relais serveur** :
   - `uiSendChatMessage` bascule sur `pushChatViaServerFallback` (même principe que
     `pushCallViaServerFallback` : relit l'état serveur, ajoute le message, repousse
     avec verrou de version) quand l'invité est déconnecté — sans ça, `peerConn.send`
     échouait silencieusement contre une connexion fermée, le message ne partait
     jamais.
   - `uiAssignSeat`, `uiDropOnSeat`, `uiDropOnKibitz`, `uiRotateSeatsClockwise`,
     `uiValidateSeatReorg` (actions hôte) appellent maintenant `saveHostGameStateToStorage()`
     — elles ne poussaient jamais vers le cloud jusqu'ici, un participant en repli
     serveur ne voyait donc jamais un changement de siège avant de se reconnecter en
     P2P.
   - `applyCloudUpdate` relaie désormais aussi (en plus des annonces) les nouveaux
     messages de chat et les changements de sièges appris via le cloud vers les
     invités restés connectés en P2P — sans ça, un invité qui n'est jamais passé par
     le cloud lui-même ne recevait jamais ce qu'un AUTRE participant en repli serveur
     venait de faire.
   - Wizz : vérifié déjà couvert sans changement — la cloche se masque dès que le
     destinataire visé est marqué déconnecté (`p.disconnected`), quel que soit le
     mode ; c'est la bonne règle, une notification "instantanée" différée n'aurait pas
     de sens pour ce genre de geste.

   **[Réévalué, pas retenue — 12 août 2026] Hystérésis formelle au retour P2P** : en
   pratique, le risque de "flip-flop" qu'elle visait à prévenir est déjà limité par la
   construction actuelle — la reconnexion automatique ne retente jamais plus vite que
   `GUEST_AUTO_RECONNECT_INTERVAL_MS` (4s), et la bascule serveur côté hôte
   (`hasDisconnectedOccupiedSeat`) est une simple vérification réactive, jamais un
   abonnement qu'on active/désactive en boucle. Une connexion vraiment instable
   causerait au pire des `resync` un peu plus fréquents que nécessaire (gaspillage de
   bande passante mineur), pas de dérive incontrôlée. Pas de complexité ajoutée pour
   un problème qui ne s'est pas manifesté concrètement — à revisiter si un vrai cas
   d'oscillation visible apparaît en testant.

   **Reste ouvert** : le cas de l'hôte hors ligne (inchangé, voir section dédiée plus
   haut — toujours pas de relais pour les annonces de l'hôte lui-même).
4. **[Fait — 12 août 2026]** Nettoyage (voir section "Ce qui disparaît" plus haut) :
   `computeSubHostId`, `currentSubHostId`, `scheduleSubHostTakeoverIfNeeded`,
   `cancelSubHostTakeoverTimer`, `attemptSubHostTakeover`,
   `promoteSelfToHostAfterTakeover`, `flashSubHostTookOverToast`,
   `GUEST_TAKEOVER_GRACE_MS`, `subHostTakeoverTimer`, `subHostDisconnectDetectedAt`,
   `SEAT_ACROSS` (devenue inutilisée) — tous retirés. `subHostId` retiré de tous les
   messages réseau (`lobby-state`, `start-game`, `resync`). `currentHostReconnectToken`
   et `selfDisconnectedAt` conservés (toujours utiles ailleurs). La bannière de
   reconnexion affiche maintenant un simple compteur de secondes pour tout le monde
   (plus de "/20s" réservé à un participant de secours) ; le bouton "Se reconnecter" reste
   visible pour tout invité déconnecté (la reconnexion automatique en tâche de fond
   n'empêche plus son affichage — un clic déclenche juste une tentative immédiate).
   `NullPeerConnection` comme classe reste en l'état (toujours utilisée par
   `uiResumeHostSession`/`uiResumeFromCloud`, volontairement hors périmètre — voir
   étape 2).
5. **[État courant — 21 août 2026]** notifications Pusher privées :
   - `pusherTrigger` est `await`é avant la réponse API afin qu'un échec de notification
     soit observé plutôt que perdu silencieusement ;
   - le canal est `private-session-XXXX` et l'abonnement passe par `/api/pusher-auth`,
     protégé par la même `accessKey` que la lecture cloud ;
   - l'événement Pusher ne transporte **jamais** le snapshot : seulement la version et
     l'horodatage. Le client relit ensuite l'état via un GET authentifié. Cette séparation
     évite d'exposer les mains ou l'état de partie dans le bus temps réel.

## Pourquoi ce document (contexte de la discussion)

Parti d'un constat simple de Guillaume : "ça ne marche vraiment pas bien" à propos des
bugs de reconnexion liés à l'ancien mécanisme d'élection automatique rencontrés en session. Décision de fond
retenue en cours de route : pas un basculement 100% serveur (trop de latence perçue à
chaque annonce, trop gros à réécrire d'un coup), ni un P2P pur amélioré (le problème est
structurel : PeerJS n'a pas de notion de présence, l'élection d'hôte est la source de
tous les bugs vus). D'où ce compromis par siège plutôt qu'une bascule globale.

## Durcissements complémentaires — 21 août 2026

- Les snapshots cloud sont maintenant rejetés si une enchère sort du vocabulaire bridge, si le siège ne correspond pas au tour, si l'annonce est illégale, ou si participants/chat ne respectent pas leur schéma public.
- Un invité ne diffuse jamais `lobby-state` pour changer sa couleur : il envoie `set-avatar-color`; l'hôte lie l'identité à la connexion, valide la palette puis rediffuse. En coupure/différé, la même mutation passe par l'API participant restreinte.
- `reserve-code` est protégé par un budget Redis à fenêtre fixe : 20 réservations/minute par couple client/origine et 300/minute globales. Un dépassement répond HTTP 429 avec `Retry-After`.
- **Rotation/révocation des capacités** : le vrai hôte peut remplacer atomiquement `accessKey` + `hostWriteKey`. Les anciennes valeurs cessent immédiatement d'autoriser GET/PUT/Pusher ; seuls les participants encore connectés et assis reçoivent la nouvelle `accessKey`. Le client propose les nouvelles clés avant le commit Redis et peut les sonder si la réponse HTTP se perd, pour éviter un verrouillage de salle après une rotation réussie mais non accusée.
- **CSP** : `index.html` interdit les handlers JavaScript inline (`script-src-attr 'none'`) et limite les scripts aux fichiers de PLAY + aux deux CDN explicitement autorisés. Le WASM PONS utilise `wasm-unsafe-eval` sur les moteurs récents et conserve aussi `unsafe-eval` pour compatibilité avec les anciens WebKit iOS (notamment iOS 15.x), qui exigent encore ce mot-clé au moment d'instancier WebAssembly. PLAY n'utilise lui-même ni `eval` ni `Function`, et `script-src-attr 'none'` reste actif. Toute l'UI passe par `ui-events.js`.
- Les bibliothèques externes restent épinglées à des versions précises. L'ajout d'un SRI externe n'est autorisé que si le hash du fichier réellement servi est vérifié au moment du build ; aucun hash non vérifié n'est inscrit dans le HTML.
- Le viewport n'interdit plus le zoom utilisateur (`maximum-scale`/`user-scalable=no` supprimés).
