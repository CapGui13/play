// realtime-updates.js — Notifications temps réel du relais cloud via Pusher Channels.
//
// Les salles utilisent désormais des CANAUX PRIVÉS (`private-session-XXXX`). Pusher
// appelle /api/pusher-auth avant chaque abonnement ; cet endpoint exige la même clé de
// capacité que /api/session. L'événement `update` ne contient plus le snapshot de partie :
// seulement version/updatedAt. L'état complet est relu via GET authentifié.

const PUSHER_KEY = '5bf66b70168c228ad966';
const PUSHER_CLUSTER = 'eu';
const PUSHER_AUTH_ENDPOINT = `${SESSION_API_BASE}/api/pusher-auth`;

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
    if (typeof Pusher === 'undefined' || PUSHER_KEY === 'TA-CLE-PUSHER') return false;
    const normalized = String(roomCode || '').toUpperCase().trim();
    const accessKey = typeof getSessionAccessKey === 'function' ? getSessionAccessKey(normalized) : null;
    if (!accessKey) return false; // polling de secours ; on réessaiera au prochain start

    unsubscribeFromSessionUpdates();
    currentAuthorizationRoomCode = normalized;
    try {
        const pusher = ensurePusherInstance();
        if (!pusher) return false;
        const channelName = channelNameFor(normalized);
        const channel = pusher.subscribe(channelName);
        channel.bind('update', (data) => onUpdate(data));
        channel.bind('pusher:subscription_error', (status) => {
            console.warn('[realtime-updates] autorisation/abonnement privé impossible, polling de secours :', status);
        });
        currentSubscribedChannel = channelName;
        return true;
    } catch (e) {
        console.warn('[realtime-updates] abonnement impossible, le sondage périodique prend le relais :', e);
        return false;
    }
}

function unsubscribeFromSessionUpdates() {
    if (pusherInstance && currentSubscribedChannel) {
        pusherInstance.unsubscribe(currentSubscribedChannel);
    }
    currentSubscribedChannel = null;
    currentAuthorizationRoomCode = null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { subscribeToSessionUpdates, unsubscribeFromSessionUpdates, channelNameFor };
}
