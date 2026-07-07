// peer-connection.js — Connexion directe entre les deux navigateurs (WebRTC via PeerJS).
//
// Un joueur "crée" une partie : un identifiant PeerJS est généré à partir d'un code à
// 4 lettres facile à partager (ex: "BQXK"), préfixé pour éviter les collisions avec
// d'autres usagers du service public PeerJS. L'autre joueur "rejoint" avec ce code.
// Une fois la connexion établie, les deux navigateurs s'échangent directement des
// messages JSON (voir PROTOCOL_NOTES ci-dessous), sans jamais passer par un serveur à nous.
//
// PROTOCOL_NOTES — messages échangés sur le DataConnection, tous de la forme { type, ... } :
//   'deals'        { type:'deals', deals:[...], hostSeats:[...] }        — envoyé par l'hôte, tout le paquet de donnes
//   'goto-board'   { type:'goto-board', boardIndex }                     — changer de donne (déclenché par n'importe qui)
//   'call'         { type:'call', boardIndex, seat, call }                — une annonce a été faite
//   'reset-auction'{ type:'reset-auction', boardIndex }                   — recommencer l'enchère de la donne en cours
//
// Diagnostic : tout ce qui touche à l'établissement de la connexion est aussi loggué en
// console (F12) avec le préfixe "[peer]", pour pouvoir diagnostiquer un blocage silencieux
// (le cas le plus fréquent avec WebRTC : la négociation ICE échoue sans erreur JS explicite).

const PEER_ID_PREFIX = 'bridge-bid-v1-';
const CONNECTION_TIMEOUT_MS = 20000; // au-delà, on considère que ça n'aboutira pas

// Configuration ICE explicite (serveurs STUN publics de Google), plutôt que de compter
// uniquement sur la config par défaut de PeerJS — plus robuste si leur config par défaut
// est temporairement indisponible ou mal adaptée au réseau de l'utilisateur.
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

function makeRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus (0/O, 1/I)
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }
    return code;
}

class BridgePeerConnection {
    constructor(handlers) {
        // handlers: { onOpen(role, roomCode), onData(msg), onPeerConnected(), onPeerDisconnected(),
        //             onError(err), onTimeout(), onSlowConnection() }
        this.handlers = handlers || {};
        this.peer = null;
        this.conn = null;
        this.role = null; // 'host' | 'guest'
        this.roomCode = null;
        this._connectTimeoutId = null;
        this._slowHintTimeoutId = null;
        this._settled = false; // vrai une fois connecté avec succès (désarme les timeouts)
    }

    _log(...args) {
        console.log('[peer]', ...args);
    }

    _clearTimers() {
        if (this._connectTimeoutId) { clearTimeout(this._connectTimeoutId); this._connectTimeoutId = null; }
        if (this._slowHintTimeoutId) { clearTimeout(this._slowHintTimeoutId); this._slowHintTimeoutId = null; }
    }

    _wireConnection(conn) {
        this.conn = conn;

        conn.on('data', (msg) => {
            if (this.handlers.onData) this.handlers.onData(msg);
        });

        conn.on('close', () => {
            this._log('DataConnection fermée');
            if (this.handlers.onPeerDisconnected) this.handlers.onPeerDisconnected();
        });

        conn.on('error', (err) => {
            this._log('Erreur DataConnection :', err);
            if (this.handlers.onError) this.handlers.onError(err);
        });

        const markConnected = () => {
            this._settled = true;
            this._clearTimers();
            this._log('DataConnection ouverte, connexion établie ✅');
            if (this.handlers.onPeerConnected) this.handlers.onPeerConnected();
        };

        if (conn.open) {
            markConnected();
        } else {
            conn.on('open', markConnected);
        }

        // Diagnostic fin : état de la négociation ICE sous-jacente (utile en console pour
        // comprendre POURQUOI une connexion reste bloquée : "checking" qui ne passe jamais
        // à "connected"/"completed" indique généralement un blocage réseau/pare-feu).
        conn.on('iceStateChanged', (state) => {
            this._log('État ICE :', state);
        });
        if (conn.peerConnection) {
            conn.peerConnection.oniceconnectionstatechange = () => {
                this._log('État ICE (peerConnection) :', conn.peerConnection.iceConnectionState);
            };
        }
    }

    _armTimeouts() {
        this._slowHintTimeoutId = setTimeout(() => {
            if (this._settled) return;
            this._log('Toujours pas connecté après 10s...');
            if (this.handlers.onSlowConnection) this.handlers.onSlowConnection();
        }, 10000);

        this._connectTimeoutId = setTimeout(() => {
            if (this._settled) return;
            this._log('Délai dépassé (20s) : abandon.');
            if (this.handlers.onTimeout) this.handlers.onTimeout();
        }, CONNECTION_TIMEOUT_MS);
    }

    // Crée une partie : génère un code, ouvre un Peer, attend qu'un adversaire se connecte.
    createRoom() {
        this.role = 'host';
        this.roomCode = makeRoomCode();
        const id = PEER_ID_PREFIX + this.roomCode;
        this._log('Création de la partie, id =', id);
        this.peer = new Peer(id, { config: ICE_CONFIG, debug: 1 });

        this.peer.on('open', () => {
            this._log('Peer hôte ouvert, en attente de connexion entrante...');
            if (this.handlers.onOpen) this.handlers.onOpen('host', this.roomCode);
        });

        this.peer.on('connection', (conn) => {
            this._log('Connexion entrante reçue de', conn.peer);
            // On n'accepte qu'un seul adversaire à la fois (2 joueurs)
            if (this.conn) { conn.close(); return; }
            this._armTimeouts();
            this._wireConnection(conn);
        });

        this.peer.on('disconnected', () => {
            this._log('Peer hôte déconnecté du serveur de signalisation.');
        });

        this.peer.on('error', (err) => {
            this._log('Erreur Peer (hôte) :', err.type, err);
            if (this.handlers.onError) this.handlers.onError(err);
        });
    }

    // Rejoint une partie déjà créée via son code à 4 lettres.
    joinRoom(roomCode) {
        this.role = 'guest';
        this.roomCode = roomCode.toUpperCase().trim();
        const targetId = PEER_ID_PREFIX + this.roomCode;
        this.peer = new Peer({ config: ICE_CONFIG, debug: 1 });

        this.peer.on('open', () => {
            this._log('Peer invité ouvert, tentative de connexion à', targetId);
            const conn = this.peer.connect(targetId, { reliable: true });
            this._armTimeouts();
            this._wireConnection(conn);
            if (this.handlers.onOpen) this.handlers.onOpen('guest', this.roomCode);
        });

        this.peer.on('disconnected', () => {
            this._log('Peer invité déconnecté du serveur de signalisation.');
        });

        this.peer.on('error', (err) => {
            this._log('Erreur Peer (invité) :', err.type, err);
            this._clearTimers();
            if (this.handlers.onError) this.handlers.onError(err);
        });
    }

    send(message) {
        if (this.conn && this.conn.open) {
            this.conn.send(message);
        }
    }

    isConnected() {
        return !!(this.conn && this.conn.open);
    }

    destroy() {
        this._clearTimers();
        if (this.conn) this.conn.close();
        if (this.peer) this.peer.destroy();
    }
}
