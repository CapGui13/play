# Architecture P2P + relais serveur (par siège)

Document de conception — voir échange avec Guillaume (session du 12 août 2026). À lire
avant de toucher au code : ce fichier remplace la logique d'élection de sous-hôte
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

**Donc : chacun valide sa propre annonce**, qu'il soit en `p2p` ou en `server` — pas
l'hôte à sa place. Le rôle d'hôte se réduit à ce qu'il est déjà en pratique pour tout le
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
de bug cette session, voir la persistance de l'état après une bascule sous-hôte).
L'hôte doit rester abonné au canal Pusher de la salle en continu, même pendant qu'il est
lui-même pleinement en P2P avec tout le monde, pour ne jamais accumuler de retard sur ce
qui se passe côté serveur pour un siège momentanément basculé.

## Les autres types de messages (pas seulement les annonces)

Chaque type de message existant a besoin de sa propre réponse à "et si ce siège est en
`server` plutôt qu'en `p2p` ?" :

| Message | Aujourd'hui (P2P) | En `server` |
|---|---|---|
| `call` (annonce) | host valide + relaie | chacun valide, écrit dans Redis (voir plus haut) |
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

   **Volontairement pas encore couvert, à traiter dans une passe ultérieure** :
   - Chat, wizz, changement de sièges via le relais serveur (voir le tableau plus haut)
     — seules les annonces d'enchère sont couvertes pour l'instant.
   - Hystérésis formelle au retour P2P (le document en parlait plus haut) — pas
     implémentée telle quelle ; l'intervalle de sondage (20s) et Pusher (déclenché
     seulement à l'écriture) amortissent déjà un peu un flip-flop, mais rien de
     garanti en cas de connexion vraiment instable.
   - Cas de l'hôte hors ligne : inchangé (voir section dédiée plus haut), toujours pas
     de relais pour les annonces de l'hôte lui-même.

   **À tester en priorité** : un invité qui annonce alors qu'il est réellement coupé
   de l'hôte (pas seulement en train de se reconnecter) — c'est le chemin neuf, jamais
   exécuté avant cette étape, et je n'ai aucun moyen de le tester en conditions réelles
   moi-même (pas d'environnement multi-appareils/réseau réel disponible ici).
4. **[Fait — 12 août 2026]** Nettoyage (voir section "Ce qui disparaît" plus haut) :
   `computeSubHostId`, `currentSubHostId`, `scheduleSubHostTakeoverIfNeeded`,
   `cancelSubHostTakeoverTimer`, `attemptSubHostTakeover`,
   `promoteSelfToHostAfterTakeover`, `flashSubHostTookOverToast`,
   `GUEST_TAKEOVER_GRACE_MS`, `subHostTakeoverTimer`, `subHostDisconnectDetectedAt`,
   `SEAT_ACROSS` (devenue inutilisée) — tous retirés. `subHostId` retiré de tous les
   messages réseau (`lobby-state`, `start-game`, `resync`). `currentHostReconnectToken`
   et `selfDisconnectedAt` conservés (toujours utiles ailleurs). La bannière de
   reconnexion affiche maintenant un simple compteur de secondes pour tout le monde
   (plus de "/20s" réservé à un sous-hôte désigné) ; le bouton "Se reconnecter" reste
   visible pour tout invité déconnecté (la reconnexion automatique en tâche de fond
   n'empêche plus son affichage — un clic déclenche juste une tentative immédiate).
   `NullPeerConnection` comme classe reste en l'état (toujours utilisée par
   `uiResumeHostSession`/`uiResumeFromCloud`, volontairement hors périmètre — voir
   étape 2).
5. **[Fait — 12 août 2026]** `api/session.js` (repo `api-gen`) :
   - `pusherTrigger` désormais `await`é avant de répondre au client, dans son propre
     try/catch — évite qu'un échec ou une coupure d'exécution en cours de route ne
     perde silencieusement la notification "temps réel" (petit coût : celui qui écrit
     attend un peu plus longtemps sa propre réponse).
   - L'événement Pusher embarque l'état complet quand il tient sous
     `PUSHER_EVENT_MAX_BYTES` (9 Ko, marge sous la limite Pusher de 10 Ko) — sinon
     repli sur l'ancien comportement (version seule). Câblé côté client :
     `realtime-updates.js` transmet maintenant le contenu de l'événement à l'appelant
     (au lieu de l'ignorer), et `onCloudPusherEvent` (nouveau, dans `app.js`) applique
     l'état directement via `applyCloudUpdate` quand il est présent — sans repasser
     par un second aller-retour GET — ou retombe sur l'ancien sondage sinon.

## Pourquoi ce document (contexte de la discussion)

Parti d'un constat simple de Guillaume : "ça ne marche vraiment pas bien" à propos des
bugs de reconnexion/élection de sous-hôte rencontrés en session. Décision de fond
retenue en cours de route : pas un basculement 100% serveur (trop de latence perçue à
chaque annonce, trop gros à réécrire d'un coup), ni un P2P pur amélioré (le problème est
structurel : PeerJS n'a pas de notion de présence, l'élection d'hôte est la source de
tous les bugs vus). D'où ce compromis par siège plutôt qu'une bascule globale.
