# PLAY — qualification régressions salon / mode différé — 2026-08-22

Baseline fonctionnelle comparée : `play OLD.zip` pour le comportement historique du menu de sièges.
Baseline de code de cette passe : `play4_differe_code_4_chiffres_seul.zip`.

## Correctifs qualifiés

- Menu de siège : clic sur toute la case, avec toggle symétrique ouvrir / refermer ; clic extérieur ferme ; tactile sans drag natif parasite.
- Reprise différée : un participant repris depuis le cloud reste un vrai `guest` et retente une vraie connexion P2P au retour de l'hôte.
- Présence : une reprise locale ne marque plus arbitrairement tous les autres participants déconnectés.
- Synchronisation différée : le cloud reste une voie de convergence même quand le P2P est revenu.
- Enchères différées : l'index de donne réellement joué est transporté explicitement jusqu'au relais serveur.
- Navigation : chaque joueur peut consulter ses donnes indépendamment en différé ; le mode live reste piloté par l'hôte.
- Fast-forward : détection par le marqueur sémantique `deferredRoomMode`, plus par `NullPeerConnection`.
- Undo différé : la donne cible est explicite.
- Identité différée : la place `PENDING` utilise l'identité stable dérivée du code, y compris si le premier contact se fait pendant que l'hôte est encore en ligne.

## Campagnes exécutées

Tests navigateur Chromium headless avec contextes indépendants et backend de session simulé suivant les règles d'accès/versions du backend :

- 18/18 scénarios principaux : reprise code seul, P2P retour, présence des deux côtés, enchères sur deux donnes différentes, fast-forward, 6 cycles de reconnexion, reprise de l'hôte.
- 100 cycles d'ouverture/fermeture du menu de siège desktop : PASS.
- 50 cycles d'ouverture/fermeture du menu de siège tactile : PASS ; absence de `draggable` natif tactile confirmée.
- 25 cycles supplémentaires de disparition/réapparition du partenaire : PASS.
- Première arrivée avec hôte fermé et siège encore `PENDING` : PASS.
- Enchère partenaire pendant fermeture complète de l'hôte puis reprise par l'hôte : PASS.
- Enchère hôte puis retour du partenaire depuis un autre contexte avec code seul : PASS.
- Identité déterministe conservée lors d'un retour depuis un nouvel appareil simulé : PASS.
- Deux enchères complètes de 4 Passes sur deux donnes distinctes, joueurs alternés et navigation indépendante : convergence PASS.
- Navigation différée réelle via boutons, sans émission `goto-board` globale : PASS.
- Undo différé ciblant la bonne donne : PASS.
- Première connexion P2P pendant siège `PENDING` : identité aléatoire rejetée, identité différée stable acceptée : PASS.
- Non-régression live, 5/5 : navigation invité verrouillée, fast-forward masqué, enchère invitée en P2P direct, pas de polling cloud quand P2P sain, navigation hôte toujours diffusée.

Le réseau externe de l'environnement de test n'autorise pas l'accès direct au déploiement Vercel ; la campagne multi-client utilise donc un backend de session simulé, complétée par l'inspection du reducer serveur `api/session.js` du dépôt connecté.
