// realtime-updates.js — Diffusion en temps réel pour le mode différé (session asynchrone
// à deux) ET pour le relais serveur par siège en mode live (voir
// ARCHITECTURE-P2P-SERVEUR.md), via Pusher Channels.
//
// Complète session-storage.js : celui-ci ne fait que lire/écrire l'état sur demande ; ici,
// on s'abonne au canal de la salle pour être prévenu DÈS qu'une écriture a eu lieu
// ailleurs, sans attendre le prochain sondage périodique (voir pollCloudForUpdates dans
// app.js, qui reste un filet de secours au cas où un événement Pusher se perdrait — la clé
// publique ci-dessous n'a jamais accès au contenu de la partie elle-même, seulement à
// "quelque chose a changé, code de salle tel, va relire" — ou, désormais, directement à
// l'état lui-même quand il tient dans la limite de taille Pusher, voir api/session.js
// côté repo api-gen).
//
// À renseigner une fois le compte Pusher créé (voir échange avec Guillaume) :
const PUSHER_KEY = '5bf66b70168c228ad966';
const PUSHER_CLUSTER = 'eu';

let pusherInstance = null;
let currentSubscribedChannel = null;

function channelNameFor(roomCode) {
    return `session-${String(roomCode || '').toUpperCase().trim()}`;
}

// S'abonne au canal de cette salle — `onUpdate(data)` est appelé avec le contenu de
// l'événement Pusher dès qu'il arrive : `{version, updatedAt}` (repli, l'appelant doit
// relire via GET) ou `{version, updatedAt, state}` (état embarqué directement, voir
// api/session.js côté repo api-gen — assez petit pour tenir dans la limite Pusher). Sans
// effet si la bibliothèque Pusher n'a pas pu charger (ex. hors-ligne, CDN bloqué) : le
// sondage périodique prend alors seul le relais, silencieusement.
function subscribeToSessionUpdates(roomCode, onUpdate) {
    if (typeof Pusher === 'undefined') return; // script Pusher pas chargé : no-op, le sondage prend le relais
    if (PUSHER_KEY === 'TA-CLE-PUSHER') return; // pas encore configuré : idem

    unsubscribeFromSessionUpdates(); // au cas où un abonnement précédent traînerait encore

    try {
        if (!pusherInstance) {
            pusherInstance = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });
        }
        const channel = pusherInstance.subscribe(channelNameFor(roomCode));
        channel.bind('update', (data) => onUpdate(data));
        currentSubscribedChannel = channelNameFor(roomCode);
    } catch (e) {
        console.warn('[realtime-updates] abonnement impossible, le sondage périodique prend le relais :', e);
    }
}

function unsubscribeFromSessionUpdates() {
    if (pusherInstance && currentSubscribedChannel) {
        pusherInstance.unsubscribe(currentSubscribedChannel);
        currentSubscribedChannel = null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { subscribeToSessionUpdates, unsubscribeFromSessionUpdates };
}
