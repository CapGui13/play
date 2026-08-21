// sw.js — Service worker de Table d'enchères.
//
// VERSIONING : ce fichier remplace le paramètre `?v=NN` qui existait auparavant sur
// chaque <script>/<link> de index.html (pratique manuelle de cache-busting, redondante
// une fois qu'un service worker gère lui-même l'invalidation). C'est CACHE_NAME qui fait
// foi (voir l'événement 'activate', qui purge automatiquement les anciens caches) — et sa
// valeur ci-dessous est réécrite AUTOMATIQUEMENT à chaque déploiement par
// .github/workflows/deploy.yml (dérivée du SHA du commit) : ne pas l'éditer à la main, ça
// n'aurait d'effet que le temps d'un test local avant le prochain push.
const CACHE_NAME = 'bridge-encheres-mini4-pons-diag-20260821';

// Ressources de la même origine : mises en cache de façon fiable via cache.addAll (un seul
// échec fait échouer toute l'installation, ce qui est le comportement voulu ici — ce sont
// les fichiers strictement nécessaires au fonctionnement de l'appli).
const CORE_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './ui-events.js',
    './bidding-rules.js',
    // PONS (~15,2 Mo brut) est volontairement absent du pré-cache d'installation.
    // Il est chargé/caché à la demande après l'entrée dans un salon ; sinon chaque
    // déploiement saturait inutilement le réseau dès l'accueil et ralentissait même
    // la réservation du code de salle.
    './deal-parser.js',
    './peer-connection.js',
    './session-storage.js',
    './realtime-updates.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-icon-180.png'
];

// Les dépendances CDN ne sont plus pré-cachées pendant l'installation. PeerJS/Pusher
// sont chargés à la demande et les polices suivent leur cache HTTP/runtime normal. Cela
// évite qu'une nouvelle version du service worker concurrence le clic « Créer » avec des
// téléchargements réseau sans rapport avec l'écran en cours.

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            // { cache: 'reload' } plutôt que cache.addAll(CORE_ASSETS) tel quel : ce
            // dernier fait un fetch() par défaut, qui peut très bien être satisfait par le
            // cache HTTP du navigateur (pas celui, distinct, de la Cache Storage API ici)
            // si GitHub Pages sert ces fichiers avec des en-têtes de cache — auquel cas ce
            // nouveau service worker se met bien à jour lui-même (CACHE_NAME différent),
            // mais y recopie des fichiers encore périmés, sans jamais vraiment retourner
            // sur le réseau. C'est très exactement ce qui obligeait à un Ctrl+Maj+R (qui,
            // lui, ignore le cache HTTP) pour voir une mise à jour appliquée (voir échange
            // avec Guillaume) : 'reload' force ici la même chose systématiquement, sans
            // rien à faire côté utilisateur.
            await Promise.all(
                CORE_ASSETS.map(async (url) => {
                    const resp = await fetch(url, { cache: 'reload' });
                    await cache.put(url, resp);
                })
            );
            // N'active pas immédiatement ce nouveau service worker : voir tryAutoApplyUpdate
            // dans app.js, qui attend qu'aucune salle ne soit active avant d'appeler
            // skipWaiting() automatiquement.
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
// méthodes (POST...) ne sont jamais interceptées, et ni le canal de données WebRTC ni la
// connexion WebSocket de signalisation elle-même ne passent par l'événement 'fetch' (ce
// sont des canaux navigateur entièrement séparés).
//
// EXCEPTION IMPORTANTE : la poignée de main HTTP initiale avec le serveur cloud PeerJS
// (avant même l'ouverture du WebSocket, pour obtenir un identifiant de connexion unique)
// PASSE, elle, par une requête GET classique — donc par ce gestionnaire. La mettre en
// cache serait un vrai bug : au prochain chargement, le navigateur resservirait le MÊME
// identifiant déjà utilisé (et donc déjà pris côté serveur) au lieu d'en demander un
// nouveau, provoquant une erreur "ID is taken" empêchant toute connexion. On laisse donc
// ce domaine passer sans jamais l'intercepter ni le mettre en cache.
//
// Voir échange avec Guillaume (session asynchrone à deux — "l'enchère du partenaire
// n'apparaît pas", des heures à chercher) : la VRAIE cause de fond, ici. `vercel.app`
// (l'API de session cloud, voir session-storage.js) est ajouté pour la même raison que
// peerjs.com, mais un cran plus grave — voir le commentaire sur `ignoreSearch` un peu
// plus bas, qui explique le mécanisme exact.
const NEVER_CACHE_HOSTS = ['peerjs.com', 'vercel.app', 'pusher.com'];

function shouldNeverCache(url) {
    try {
        const hostname = new URL(url).hostname;
        return NEVER_CACHE_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
    } catch (e) {
        return false;
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (!request.url.startsWith('http')) return;
    if (shouldNeverCache(request.url)) return; // laisse passer sans intercepter (voir ci-dessus)

    // Voir échange avec Guillaume : `ignoreSearch: true` ci-dessous ignore délibérément
    // tout ce qui suit le "?" dans l'URL pour retrouver une entrée en cache — pratique
    // pour les fichiers de l'appli elle-même (un éventuel "?v=..." de cache-busting
    // manuel ne doit pas créer une seconde entrée), mais catastrophique appliqué à un
    // appel d'API : `/api/session?code=1234` et `/api/session?code=5678` partagent alors
    // la MÊME entrée de cache, ignorant totalement le code de salle demandé — première
    // requête mise en cache, TOUTES les suivantes (n'importe quel code, n'importe quel
    // paramètre anti-cache ajouté côté client) reçoivent cette même vieille réponse.
    // NEVER_CACHE_HOSTS protège déjà l'hôte de l'API en le laissant filer sans jamais
    // l'intercepter — mais on se protège ICI AUSSI d'un même mécanisme sur un futur appel
    // externe qu'on aurait oublié d'y ajouter : ignoreSearch ne s'applique plus qu'aux
    // requêtes de MÊME ORIGINE que le site (nos propres fichiers), jamais à un appel vers
    // un autre domaine.
    const isSameOrigin = (() => {
        try { return new URL(request.url).origin === self.location.origin; }
        catch (e) { return false; }
    })();
    const forceFreshPons = (() => {
        try {
            const u = new URL(request.url);
            return isSameOrigin && u.searchParams.has('__pons_fresh') && u.pathname.includes('/pons/');
        } catch (e) { return false; }
    })();

    // Une retentative explicite du loader PONS doit pouvoir contourner une entrée cache
    // douteuse. Sans ce chemin, ignoreSearch:true pourrait resservir exactement le même
    // fichier au retry malgré son paramètre anti-cache.
    if (forceFreshPons) {
        event.respondWith((async () => {
            const response = await fetch(request, { cache: 'reload' });
            if (response && response.ok) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
            }
            return response;
        })());
        return;
    }

    event.respondWith(
        (async () => {
            const cached = await caches.match(request, { ignoreSearch: isSameOrigin });
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
