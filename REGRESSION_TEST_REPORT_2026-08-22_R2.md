# PLAY — vérification corrective R2 — 2026-08-22

## Cause racine constatée

Le dépôt contenait déjà le correctif de toggle et le lien différé court, mais le Service Worker de la release précédente conservait volontairement les nouvelles versions en état `waiting`. Un navigateur pouvait donc continuer à exécuter une ancienne copie de `app.js`, ce qui reproduisait exactement :

- le menu de siège qui se rouvre au second clic ;
- l'ancien lien différé contenant des capacités longues.

## Correctifs R2

1. Les cases de sièges et les options de leurs menus ont maintenant leurs propres listeners DOM, comme la sémantique de la version OLD. Le toggle ne dépend plus d'un listener délégué sur `document`.
2. `buildRoomShareUrl` exige strictement un code de salle à 4 chiffres et génère un lien sans fragment de capacité.
3. Le Service Worker active immédiatement un cache entièrement préchargé (`skipWaiting`) au lieu de laisser indéfiniment la release en attente.
4. Compatibilité conservée avec les anciennes pages qui envoient le message `skipWaiting`.
5. Après activation, une page encore servie par l'ancien worker est rechargée uniquement si elle est restée sur l'accueil sans paramètre `room`; aucune salle ou invitation active n'est naviguée automatiquement.

## Tests exécutés

- `node --check` : tous les fichiers JS racine — PASS.
- `session-storage.js`, `peer-connection.js`, `realtime-updates.js` : identiques octet pour octet à la release de stabilité différée précédente — PASS.
- Chromium headless avec DOM/CSS réels injectés :
  - 200 toggles consécutifs du siège Nord robot — PASS ;
  - 20 clics souris physiques par coordonnées sur la case Nord — PASS ;
  - clic extérieur — PASS ;
  - bascule Nord -> Est — PASS ;
  - sélection d'une option puis fermeture sans réouverture — PASS ;
  - robot non draggable — préservé ;
  - lien `room=4728`, hash vide — PASS ;
  - code long rejeté — PASS.
- Service Worker dans harness VM :
  - activation `skipWaiting` — PASS ;
  - `clients.claim()` — PASS ;
  - recharge de l'accueil sans `room` — PASS ;
  - aucune navigation du client `?room=1234` — PASS ;
  - message legacy `skipWaiting` — PASS.

## Portée

Cette passe ne modifie pas la logique réseau différée elle-même. Les modules de persistance/session, PeerJS et Pusher sont inchangés par rapport à `play4_stabilite_differe_et_sieges.zip`.
