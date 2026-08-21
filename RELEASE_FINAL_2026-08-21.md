# PLAY — PRODUCTION STABLE FINAL — 2026-08-21

Baseline fonctionnelle : MINI UPDATES 8, validée par smoke utilisateur.

Cette clôture ne modifie aucune logique de jeu, de réseau, de PONS ou d'interface.
Elle effectue uniquement :
- un nouveau `CACHE_NAME` de Service Worker pour garantir que la release finale soit effectivement récupérée par les clients déjà cachés ;
- la correction de documentation devenue obsolète sur le mode de déploiement et le bouton de rotation d'accès ;
- la correction d'un commentaire CSS obsolète, sans changement de règle CSS.

PONS : inchangé.
API-GEN associée : `API_GEN_PERF2_FAST_CREATE_FULL_REPOSITORY_2026-08-21.zip` (runtime inchangé depuis le lot PERF2).


## HARDENED FINAL R1 — 2026-08-21

- Export PBN GitHub : authentification obligatoire par les capacités de salle (hôte ou participant assis) et rate-limit serveur.
- DDS : validation sémantique stricte des 52 cartes avant solveur + rate-limit Redis par coût.
- Import PBN/LIN : vulnérabilité explicitement invalide refusée au lieu d'être convertie silencieusement en `None`.
- Service Worker : le pré-cache d'installation refuse désormais toute réponse HTTP non-2xx ; un déploiement partiel ne peut plus figer un 404/5xx dans le cache.
- Aucun changement du moteur PONS ni des règles d'enchères.
- Auto-hébergement PeerJS/Pusher conservé pour un lot séparé : Pusher charge lui-même des fallbacks dynamiques, donc le remplacer sans build fournisseur dédié aurait un risque fonctionnel disproportionné pour cette passe.
