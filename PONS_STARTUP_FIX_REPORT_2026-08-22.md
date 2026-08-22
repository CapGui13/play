# PLAY — correctif lancement PONS (22/08/2026)

## Symptôme reproduit / audité
Au lancement d'une séance avec au moins un siège robot PONS (cas fréquent avec un partenaire `PENDING`), l'overlay « Préparation du moteur PONS… » pouvait rester affiché indéfiniment.

## Cause
Le chargeur lazy attendait sans borne deux opérations réseau importantes :
- `fetch()` de `pons/canonical-rules-v1.json` (~9,5 Mo) ;
- la Promise `PONS_WASM_RUNTIME_READY`, elle-même adossée à un `fetch()` du WASM (~3,6 Mo).

Un fetch navigateur qui restait pending ne rejetait jamais : le retry/fallback existant n'était donc jamais atteint.

## Correctifs
- timeout + AbortController sur le JSON des règles ;
- timeout + AbortController directement dans `pons-wasm-runtime.js` ;
- timeout autour de `PONS_WASM_RUNTIME_READY` ;
- délais bornés sur le chargement des scripts ;
- garde globale de 110 s au lancement : même une combinaison d'échecs ne peut plus laisser l'overlay tourner sans fin ;
- fallback WASM embarqué historique conservé ; aucun fallback silencieux vers un autre moteur ;
- cache Service Worker bumpé.

## Tests
- `node --check` : app.js, pons-wasm-runtime.js, sw.js : PASS.
- simulation Node d'un fetch WASM qui ne répond jamais et ne se termine que sur AbortSignal : PASS ; rejet `PonsWasmTimeoutError` après expiration simulée.
- vérification de périmètre : `session-storage.js`, `peer-connection.js`, `realtime-updates.js`, `bidding-rules.js`, `deal-parser.js`, `ui-events.js`, `styles.css` inchangés par rapport à R2.

## Remarque
Le test Chromium localhost de l'environnement d'audit n'est pas exploitable : Chromium y reste lui-même bloqué lors de la navigation localhost. Il n'est donc pas compté comme validation E2E.
