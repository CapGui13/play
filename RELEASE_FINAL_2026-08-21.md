# PLAY — PRODUCTION STABLE FINAL — 2026-08-21

Baseline fonctionnelle : MINI UPDATES 8, validée par smoke utilisateur.

Cette clôture ne modifie aucune logique de jeu, de réseau, de PONS ou d'interface.
Elle effectue uniquement :
- un nouveau `CACHE_NAME` de Service Worker pour garantir que la release finale soit effectivement récupérée par les clients déjà cachés ;
- la correction de documentation devenue obsolète sur le mode de déploiement et le bouton de rotation d'accès ;
- la correction d'un commentaire CSS obsolète, sans changement de règle CSS.

PONS : inchangé.
API-GEN associée : `API_GEN_PERF2_FAST_CREATE_FULL_REPOSITORY_2026-08-21.zip` (runtime inchangé depuis le lot PERF2).
