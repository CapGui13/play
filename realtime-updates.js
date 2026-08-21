// realtime-updates.js — Notifications temps réel du relais cloud via Pusher Channels.
//
// Les salles utilisent désormais des CANAUX PRIVÉS (`private-session-XXXX`). Pusher
// appelle /api/pusher-auth avant chaque abonnement ; cet endpoint exige la même clé de
// capacité que /api/session. L'événement `update` ne contient plus le snapshot de partie :
// seulement version/updatedAt. L'état complet est relu via GET authentifié.

const PUSHER_KEY = '5bf66b70168c228ad966';
const PUSHER_CLUSTER = 'eu';
const PUSHER_AUTH_ENDPOINT = `${SESSION_API_BASE}/api/pusher-auth`;
const PUSHER_SCRIPT_URLS = [
    'https://js.pusher.com/8.4.0/pusher.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pusher/8.4.0/pusher.min.js'
];
let pusherLibraryLoadPromise = null;
let pusherSubscriptionGeneration = 0;

function realtimePerf(name, detail) {
    try {
        if (typeof window !== 'undefined' && typeof window.recordPlayPerfMilestone === 'function') {
            window.recordPlayPerfMilestone(name, detail);
        }
    } catch (e) { /* diagnostic seulement */ }
}

function loadPusherScript(url, attempt) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.pusherLoader = String(attempt);
        let settled = false;
        const timer = setTimeout(() => finish(false, new Error('Pusher CDN timeout')), 20000);
        const finish = (ok, err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (ok && typeof Pusher !== 'undefined') resolve(Pusher);
            else {
                script.remove();
                reject(err || new Error('Pusher global absent après chargement'));
            }
        };
        script.addEventListener('load', () => finish(true), { once: true });
        script.addEventListener('error', () => finish(false, new Error('Pusher CDN indisponible')), { once: true });
        document.head.appendChild(script);
    });
}

async function ensurePusherLibraryReady() {
    if (typeof Pusher !== 'undefined') return Pusher;
    if (pusherLibraryLoadPromise) return pusherLibraryLoadPromise;
    pusherLibraryLoadPromise = (async () => {
        realtimePerf('pusher-load-start');
        let lastError;
        for (let i = 0; i < PUSHER_SCRIPT_URLS.length; i++) {
            try {
                const value = await loadPusherScript(PUSHER_SCRIPT_URLS[i], i);
                realtimePerf('pusher-load-ready', { source: i === 0 ? 'pusher-cdn' : 'cdnjs' });
                return value;
            } catch (err) {
                lastError = err;
                realtimePerf('pusher-load-source-failed', { source: i === 0 ? 'pusher-cdn' : 'cdnjs' });
            }
        }
        throw lastError || new Error('Pusher indisponible');
    })().catch(err => {
        pusherLibraryLoadPromise = null;
        throw err;
    });
    return pusherLibraryLoadPromise;
}

let pusherInstance = null;
let currentSubscribedChannel = null;
let currentAuthorizationRoomCode = null;

function channelNameFor(roomCode) {
    return `private-session-${String(roomCode || '').toUpperCase().trim()}`;
}

function ensurePusherInstance() {
    if (pusherInstance || typeof Pusher === 'undefined' || PUSHER_KEY === 'TA-CLE-PUSHER') return pusherInstance;
    pusherInstance = new Pusher(PUSHER_KEY, {
        cluster: PUSHER_CLUSTER,
        forceTLS: true,
        channelAuthorization: {
            endpoint: PUSHER_AUTH_ENDPOINT,
            transport: 'ajax',
            headersProvider: () => {
                const accessKey = (typeof getSessionAccessKey === 'function' && currentAuthorizationRoomCode)
                    ? getSessionAccessKey(currentAuthorizationRoomCode)
                    : null;
                return accessKey ? { 'X-Bridge-Session-Key': accessKey } : {};
            }
        }
    });
    return pusherInstance;
}

function subscribeToSessionUpdates(roomCode, onUpdate) {
    if (PUSHER_KEY === 'TA-CLE-PUSHER') return false;
    const normalized = String(roomCode || '').toUpperCase().trim();
    const accessKey = typeof getSessionAccessKey === 'function' ? getSessionAccessKey(normalized) : null;
    if (!accessKey) return false; // polling de secours ; on réessaiera au prochain start

    const generation = ++pusherSubscriptionGeneration;
    // Le caller n'a pas besoin d'attendre Pusher : le polling cloud existe déjà comme
    // filet de sécurité. On charge donc le SDK en arrière-plan seulement une fois la salle
    // réellement connue, sans bloquer accueil / Create / Join.
    ensurePusherLibraryReady().then(() => {
        if (generation !== pusherSubscriptionGeneration) return;
        unsubscribeFromSessionUpdates(false);
        if (generation !== pusherSubscriptionGeneration) return;
        currentAuthorizationRoomCode = normalized;
        try {
            const pusher = ensurePusherInstance();
            if (!pusher) return;
            const channelName = channelNameFor(normalized);
            const channel = pusher.subscribe(channelName);
            channel.bind('update', (data) => onUpdate(data));
            channel.bind('pusher:subscription_error', (status) => {
                console.warn('[realtime-updates] autorisation/abonnement privé impossible, polling de secours :', status);
            });
            currentSubscribedChannel = channelName;
            realtimePerf('pusher-subscribed', { roomCode: normalized });
        } catch (e) {
            console.warn('[realtime-updates] abonnement impossible, le sondage périodique prend le relais :', e);
        }
    }).catch((e) => {
        console.warn('[realtime-updates] SDK Pusher indisponible, polling de secours :', e);
    });
    return true;
}

function unsubscribeFromSessionUpdates(invalidatePending = true) {
    if (invalidatePending) pusherSubscriptionGeneration++;
    if (pusherInstance && currentSubscribedChannel) {
        pusherInstance.unsubscribe(currentSubscribedChannel);
    }
    currentSubscribedChannel = null;
    currentAuthorizationRoomCode = null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { subscribeToSessionUpdates, unsubscribeFromSessionUpdates, channelNameFor };
}
