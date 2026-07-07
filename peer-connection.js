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
const CONNECTION_TIMEOUT_MS = 45000; // au-delà, on considère que ça n'aboutira pas

// Configuration ICE explicite : serveurs STUN publics de Google (découverte d'adresse),
// complétés par un serveur TURN (ExpressTURN, compte gratuit) qui relaie réellement les
// données quand une connexion directe échoue — cas fréquent avec les NAT restrictifs,
// certains pare-feux, ou le "NAT hairpinning" (deux appareils sur le même réseau qui
// n'arrivent pas à se joindre via leur IP publique commune).
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:free.expressturn.com:3478',
            username: '000000002098770532',
            credential: 'zIohrx8x/vvzdIwz7VVCZ1nj2fI='
        },
        {
            urls: 'turn:free.expressturn.com:3478?transport=tcp',
            username: '000000002098770532',
            credential: 'zIohrx8x/vvzdIwz7VVCZ1nj2fI='
        },
        {
            urls: 'turns:free.expressturn.com:443?transport=tcp',
            username: '000000002098770532',
            credential: 'zIohrx8x/vvzdIwz7VVCZ1nj2fI='
        }
    ]
};

// Test isolé : force tout le trafic à passer par TURN (iceTransportPolicy:'relay'), sans
// STUN ni connexion directe. Si aucun candidat "relay" n'apparaît ici, le problème est
// bien le serveur TURN lui-même (injoignable depuis ce réseau, ou identifiants refusés) —
// indépendamment de PeerJS. Résultat loggué dans le panneau de diagnostic.
function testTurnConnectivity() {
    const log = (typeof pushDebugLog === 'function') ? pushDebugLog : (s => console.log(s));
    log('--- Test TURN isolé (iceTransportPolicy=relay) ---');

    const pc = new RTCPeerConnection({ iceServers: ICE_CONFIG.iceServers, iceTransportPolicy: 'relay' });
    let gotRelay = false;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            log('Test TURN — candidat reçu, type = ' + (event.candidate.type || '?'));
            if (event.candidate.type === 'relay') gotRelay = true;
        } else {
            log('Test TURN — récolte terminée. Résultat : ' + (gotRelay ? '✅ TURN joignable !' : '❌ Aucun relais obtenu.'));
            pc.close();
        }
    };
    pc.onicecandidateerror = (event) => {
        log('Test TURN — erreur : ' + event.errorCode + ' ' + event.errorText + ' (' + event.url + ')');
    };
    pc.oniceconnectionstatechange = () => {
        log('Test TURN — état ICE : ' + pc.iceConnectionState);
    };

    pc.createDataChannel('test');
    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .catch(err => log('Test TURN — erreur createOffer : ' + err.message));

    setTimeout(() => {
        if (!gotRelay) log('Test TURN — toujours rien après 12s, abandon du test.');
        pc.close();
    }, 12000);
}

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
        if (typeof pushDebugLog === 'function') {
            const text = args.map(a => {
                if (a instanceof Error) return a.message;
                if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
                return String(a);
            }).join(' ');
            pushDebugLog(text);
        }
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

        // Diagnostic fin : état de la négociation ICE sous-jacente. conn.peerConnection
        // n'existe pas forcément encore à cet instant précis (créé un peu plus tard en
        // interne par PeerJS) : on réessaye toutes les 150ms jusqu'à ce qu'il soit là, pour
        // ne rater aucune transition d'état.
        // IMPORTANT : on utilise addEventListener (jamais une affectation directe genre
        // pc.onicecandidate = ...), pour ne surtout pas écraser la gestion interne de
        // PeerJS — qui a justement besoin de onicecandidate pour transmettre les candidats
        // à l'autre joueur. Écraser cette référence casserait l'échange ICE en silence.
        const attachPCDiagnostics = () => {
            const pc = conn.peerConnection;
            if (!pc) {
                if (!this._settled) setTimeout(attachPCDiagnostics, 150);
                return;
            }
            this._log('Diagnostic attaché à peerConnection, état actuel :', pc.iceConnectionState);
            pc.addEventListener('iceconnectionstatechange', () => {
                this._log('État ICE (peerConnection) :', pc.iceConnectionState);
            });
            pc.addEventListener('icecandidate', (event) => {
                if (event.candidate) {
                    const parts = event.candidate.candidate.split(' ');
                    const typIndex = parts.indexOf('typ');
                    const candType = typIndex !== -1 ? parts[typIndex + 1] : '?';
                    this._log('Candidat ICE récolté, type =', candType);
                } else {
                    this._log('Récolte des candidats ICE terminée.');
                }
            });
            pc.addEventListener('icecandidateerror', (event) => {
                this._log('Erreur candidat ICE :', event.errorCode, event.errorText, event.url);
            });
        };
        attachPCDiagnostics();
    }

    _armTimeouts() {
        this._slowHintTimeoutId = setTimeout(() => {
            if (this._settled) return;
            this._log('Toujours pas connecté après 10s...');
            if (this.handlers.onSlowConnection) this.handlers.onSlowConnection();
        }, 15000);

        this._connectTimeoutId = setTimeout(() => {
            if (this._settled) return;
            this._log('Délai dépassé (45s) : abandon.');
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
