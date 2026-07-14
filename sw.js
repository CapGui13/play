// sw.js — Service worker de Table d'enchères.
//
// VERSIONING : ce fichier remplace le paramètre `?v=NN` qui existait auparavant sur
// chaque <script>/<link> de index.html (pratique manuelle de cache-busting, redondante
// une fois qu'un service worker gère lui-même l'invalidation). C'est désormais CACHE_NAME
// qui fait foi : à chaque déploiement qui touche un fichier mis en cache ci-dessous,
// incrémenter le numéro de version pour forcer la mise à jour chez tout le monde (voir
// l'événement 'activate', qui purge automatiquement les anciens caches).
const CACHE_NAME = 'bridge-encheres-v3';

// Ressources de la même origine : mises en cache de façon fiable via cache.addAll (un seul
// échec fait échouer toute l'installation, ce qui est le comportement voulu ici — ce sont
// les fichiers strictement nécessaires au fonctionnement de l'appli).
const CORE_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './bidding-rules.js',
    './deal-parser.js',
    './peer-connection.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-icon-180.png'
];

// Ressources externes (CDN PeerJS, feuille de style Google Fonts) : utiles hors-ligne,
// mais pas strictement critiques et hors de notre contrôle (CORS, disponibilité). Mises en
// cache en best-effort (voir Promise.allSettled dans 'install') pour qu'un échec sur l'une
// d'elles ne bloque pas l'installation du reste. Note : la feuille de style Google Fonts
// référence elle-même des fichiers de police (.woff2) dont l'URL exacte n'est connue qu'à
// la lecture de son contenu — impossible de les pré-cacher ici à l'avance. Ils seront mis
// en cache au fil de l'eau par le gestionnaire 'fetch' ci-dessous, dès leur premier
// chargement réel (mais resteront indisponibles hors-ligne tant que ce premier chargement
// n'a pas eu lieu au moins une fois).
const EXTERNAL_ASSETS = [
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Work+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            await cache.addAll(CORE_ASSETS);
            await Promise.allSettled(
                EXTERNAL_ASSETS.map(async (url) => {
                    // mode:'no-cors' : ces domaines ne renvoient pas forcément d'en-têtes
                    // CORS permissifs. La réponse est alors "opaque" (illisible pour nous,
                    // mais parfaitement rejouable par le navigateur) — suffisant pour de la
                    // mise en cache pure, sans avoir besoin d'en inspecter le contenu.
                    const resp = await fetch(url, { mode: 'no-cors' });
                    await cache.put(url, resp);
                })
            );
            // N'active pas immédiatement ce nouveau service worker : voir la logique de
            // bannière "nouvelle version" dans app.js (initServiceWorker), qui attend une
            // confirmation explicite de l'utilisateur avant d'appeler skipWaiting().
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
            await self.clients.claim();
        })()
    );
});

// Stratégie "cache d'abord, réseau en secours" : sert instantanément depuis le cache si
// disponible (y compris hors-ligne), sinon va chercher sur le réseau et met en cache le
// résultat pour la prochaine fois. Ne s'applique qu'aux requêtes GET http(s) — les autres
// méthodes (POST...) ne sont jamais interceptées, et ni WebSocket ni WebRTC ne passent de
// toute façon par l'événement 'fetch' (ce sont des canaux navigateur entièrement séparés,
// il n'y a donc rien de spécifique à faire ici pour "ne jamais les mettre en cache").
self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (!request.url.startsWith('http')) return;

    event.respondWith(
        (async () => {
            const cached = await caches.match(request, { ignoreSearch: true });
            if (cached) return cached;

            try {
                const response = await fetch(request);
                // Ne met en cache que les réponses exploitables : une réponse "opaque"
                // (requête cross-origin sans CORS, ex. Google Fonts) a status 0 mais reste
                // valide à mettre en cache ; une vraie erreur réseau lève une exception,
                // capturée plus bas.
                if (response && (response.ok || response.type === 'opaque')) {
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(request, response.clone());
                }
                return response;
            } catch (err) {
                // Ni cache ni réseau : sans réponse de secours à proposer (pas de page
                // "hors-ligne" dédiée pour ce projet), on laisse simplement échouer —
                // c'est à app.js de détecter navigator.onLine et d'adapter l'interface en
                // amont plutôt que de compter sur le service worker pour ça.
                throw err;
            }
        })()
    );
});

// Message envoyé par app.js quand l'utilisateur clique "Recharger" sur la bannière de mise
// à jour (voir initServiceWorker) : fait passer ce nouveau service worker en 'activate'
// immédiatement au lieu d'attendre la fermeture de tous les onglets.
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});
