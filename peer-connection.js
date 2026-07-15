// peer-connection.js — Connexion directe entre les navigateurs (WebRTC via PeerJS).
//
// Un joueur "crée" une partie : un identifiant PeerJS est généré à partir d'un code à
// 4 lettres facile à partager (ex: "BQXK"), préfixé pour éviter les collisions avec
// d'autres usagers du service public PeerJS. Le(s) autre(s) joueur(s) "rejoignent" avec
// ce code. Une fois connectés, les navigateurs s'échangent directement des messages JSON
// (voir PROTOCOL_NOTES ci-dessous), sans jamais passer par un serveur à nous.
//
// Deux topologies possibles selon le mode de jeu :
//   - 2 joueurs (modes "binôme" / "diagonale") : un hôte, un invité, connexion directe.
//   - 3 joueurs (mode "maître du jeu") : un hôte accepte 2 invités. Les invités ne sont
//     jamais connectés entre eux — l'hôte agit comme relais central (topologie en étoile) :
//     tout message reçu d'un invité est ré-émis par l'hôte vers l'autre invité.
//
// PROTOCOL_NOTES — messages échangés, tous de la forme { type, ... } :
//   'deals'          { type:'deals', deals:[...], seatAssignment:{...} } — envoyé par l'hôte, une fois
//   'goto-board'     { type:'goto-board', boardIndex }
//   'call'           { type:'call', boardIndex, seat, call }
//   'reset-auction'  { type:'reset-auction', boardIndex }
//
//   Demande d'annulation (undo) — voir app.js pour le détail, l'hôte arbitre toujours :
//   'undo-request'   { type:'undo-request', boardIndex, requesterId, historyLengthAtRequest }
//   'undo-ask'       { type:'undo-ask', boardIndex, requesterId, historyLengthAtRequest }
//   'undo-answer'    { type:'undo-answer', boardIndex, requesterId, historyLengthAtRequest, approved }
//   'undo-apply'     { type:'undo-apply', boardIndex }
//   'undo-rejected'  { type:'undo-rejected', boardIndex, requesterId, reason }
//
//   Reconnexion — voir app.js pour le détail. Chaque invité porte un jeton persistant
//   (sessionStorage) transmis en métadonnées de connexion PeerJS (conn.metadata), qui sert
//   d'identifiant stable indépendant du numéro de connexion (guestIndex) — celui-ci change
//   à chaque reconnexion, contrairement au jeton :
//   'resync'           { type:'resync', deals, boardIndex, auctionHistory, yourSeats, botSeats }
//   (botSeats reste celui décidé au lancement de la partie — un joueur déconnecté n'est
//   PAS remplacé par un robot, son siège attend simplement sa reconnexion)
//
// Diagnostic : tout ce qui touche à l'établissement de la connexion est aussi loggué en
// console (F12) et dans le panneau de diagnostic à l'écran (préfixe "[peer]").

const PEER_ID_PREFIX = 'bridge-bid-v1-';
const CONNECTION_TIMEOUT_MS = 45000; // au-delà, on considère que ça n'aboutira pas

// Configuration ICE explicite : serveurs STUN publics de Google (découverte d'adresse),
// complétés par un serveur TURN (ExpressTURN, compte gratuit) qui relaie réellement les
// données quand une connexion directe échoue — cas fréquent avec les NAT restrictifs,
// certains pare-feux, ou le "NAT hairpinning".
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
// STUN ni connexion directe. Résultat loggué dans le panneau de diagnostic.
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
        // handlers: { onOpen(role, roomCode), onData(msg, guestIndex), onGuestConnected(guestIndex, metadata),
        //             onAllConnected(), onPeerConnected(), onPeerDisconnected(guestIndex), onError(err),
        //             onTimeout(), onSlowConnection() }
        // (onPeerConnected / onPeerDisconnected sans index restent déclenchés aussi, pour compat avec les modes à 2 joueurs)
        this.handlers = handlers || {};
        this.peer = null;
        this.conns = [];       // connexions actives, dans l'ordre de connexion (index = "guestIndex")
        this.role = null;      // 'host' | 'guest'
        this.roomCode = null;
        this.maxGuests = 1;
        this._connectTimeoutId = null;
        this._slowHintTimeoutId = null;
        this._settled = false; // vrai une fois au moins une connexion établie (désarme les timeouts)
        // Vrai tant que la connexion au serveur de signalisation PeerJS tient (voir
        // isConnected ci-dessous et l'événement 'disconnected' dans createRoom/joinRoom) :
        // distinct de l'état ouvert/fermé des DataConnection p2p elles-mêmes, qui peuvent
        // rester "ouvertes" un moment après une coupure côté signalisation.
        this.signalingOpen = true;
    }

    get conn() {
        // Alias pour compatibilité : la première (et souvent unique) connexion.
        return this.conns[0] || null;
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

    _wireConnection(conn, guestIndex) {
        conn.on('data', (msg) => {
            if (this.handlers.onData) this.handlers.onData(msg, guestIndex);
        });

        conn.on('close', () => {
            this._log(`DataConnection #${guestIndex} fermée`);
            // On libère le créneau (au lieu de laisser traîner la connexion fermée) pour
            // qu'il puisse être réutilisé par une reconnexion, et pour ne pas finir par
            // épuiser artificiellement `maxGuests` au fil des déconnexions/reconnexions.
            if (this.conns[guestIndex] === conn) this.conns[guestIndex] = null;
            if (this.handlers.onPeerDisconnected) this.handlers.onPeerDisconnected(guestIndex);
        });

        conn.on('error', (err) => {
            this._log(`Erreur DataConnection #${guestIndex} :`, err);
            if (this.handlers.onError) this.handlers.onError(err);
        });

        const markConnected = () => {
            this._settled = true;
            this._clearTimers();
            this._log(`DataConnection #${guestIndex} ouverte, connexion établie ✅`);
            // conn.metadata : ce que l'invité a passé à peer.connect(..., {metadata}) côté
            // joinRoom — sert notamment à transmettre un jeton de reconnexion (voir app.js).
            if (this.handlers.onGuestConnected) this.handlers.onGuestConnected(guestIndex, conn.metadata || {});
            if (this.handlers.onPeerConnected) this.handlers.onPeerConnected(guestIndex);
        };

        if (conn.open) {
            markConnected();
        } else {
            conn.on('open', markConnected);
        }

        // Diagnostic fin : état de la négociation ICE sous-jacente. conn.peerConnection
        // n'existe pas forcément encore à cet instant précis (créé un peu plus tard en
        // interne par PeerJS) : on réessaye toutes les 150ms jusqu'à ce qu'il soit là.
        // IMPORTANT : on utilise addEventListener (jamais une affectation directe genre
        // pc.onicecandidate = ...), pour ne surtout pas écraser la gestion interne de
        // PeerJS — qui a justement besoin de onicecandidate pour transmettre les candidats
        // à l'autre joueur. Écraser cette référence casserait l'échange ICE en silence.
        const attachPCDiagnostics = () => {
            const pc = conn.peerConnection;
            if (!pc) {
                if (!conn.open) setTimeout(attachPCDiagnostics, 150);
                return;
            }
            this._log(`[#${guestIndex}] Diagnostic attaché à peerConnection, état actuel :`, pc.iceConnectionState);
            pc.addEventListener('iceconnectionstatechange', () => {
                this._log(`[#${guestIndex}] État ICE (peerConnection) :`, pc.iceConnectionState);
            });
            pc.addEventListener('icecandidate', (event) => {
                if (event.candidate) {
                    const parts = event.candidate.candidate.split(' ');
                    const typIndex = parts.indexOf('typ');
                    const candType = typIndex !== -1 ? parts[typIndex + 1] : '?';
                    this._log(`[#${guestIndex}] Candidat ICE récolté, type =`, candType);
                } else {
                    this._log(`[#${guestIndex}] Récolte des candidats ICE terminée.`);
                }
            });
            pc.addEventListener('icecandidateerror', (event) => {
                this._log(`[#${guestIndex}] Erreur candidat ICE :`, event.errorCode, event.errorText, event.url);
            });
        };
        attachPCDiagnostics();
    }

    _armTimeouts() {
        this._slowHintTimeoutId = setTimeout(() => {
            if (this._settled) return;
            this._log('Toujours pas connecté après 15s...');
            if (this.handlers.onSlowConnection) this.handlers.onSlowConnection();
        }, 15000);

        this._connectTimeoutId = setTimeout(() => {
            if (this._settled) return;
            this._log('Délai dépassé (45s) : abandon.');
            if (this.handlers.onTimeout) this.handlers.onTimeout();
        }, CONNECTION_TIMEOUT_MS);
    }

    // Crée une partie : génère un code, ouvre un Peer, accepte les invités au fil de l'eau
    // (jusqu'à `cap`, une limite de sécurité — la composition réelle de la table est décidée
    // librement par l'hôte dans le salon, pas à la création de la partie).
    createRoom(cap = 6) {
        this.role = 'host';
        this.maxGuests = cap;
        this.roomCode = makeRoomCode();
        const id = PEER_ID_PREFIX + this.roomCode;
        this._log('Création de la partie, id =', id);
        this.peer = new Peer(id, { config: ICE_CONFIG, debug: 1 });

        this.peer.on('open', () => {
            this._log('Peer hôte ouvert, en attente de connexions...');
            this.signalingOpen = true; // aussi vrai en cas de succès d'un reconnect() après coupure
            if (this.handlers.onOpen) this.handlers.onOpen('host', this.roomCode);
        });

        this.peer.on('connection', (conn) => {
            this._log('Connexion entrante reçue de', conn.peer);
            // Réutilise un créneau libéré par un départ précédent plutôt que d'en créer un
            // nouveau à chaque fois — sinon `maxGuests` finit par être atteint artificiellement
            // après plusieurs allers-retours de connexion, et plus personne ne peut rejoindre.
            let guestIndex = this.conns.findIndex(c => c === null);
            if (guestIndex === -1) {
                if (this.conns.length >= this.maxGuests) { conn.close(); return; }
                guestIndex = this.conns.length;
                this.conns.push(conn);
            } else {
                this.conns[guestIndex] = conn;
            }
            this._armTimeouts();
            this._wireConnection(conn, guestIndex);
        });

        this.peer.on('disconnected', () => {
            this._log('Peer hôte déconnecté du serveur de signalisation, tentative de reconnexion automatique...');
            // Distinct de 'close' sur une DataConnection (voir onPeerDisconnected) : ici,
            // c'est la connexion au serveur de signalisation PeerJS lui-même qui est
            // tombée (WebSocket coupé — Wi-Fi, mise en veille, ou simplement un NAT/pare-
            // feu qui referme une connexion restée inactive un moment : voir échange avec
            // Guillaume, "un second invité n'arrive plus à rejoindre après quelques
            // minutes" — le premier invité, déjà connecté en direct, ne s'en aperçoit même
            // pas, mais l'hôte devient injoignable pour quiconque essaierait de le
            // rejoindre APRÈS coup). Les parties déjà établies avec des invités continuent
            // parfois de fonctionner un moment via leur canal WebRTC direct, mais plus
            // personne de nouveau ne peut rejoindre tant que ce n'est pas rétabli.
            // this.peer.reconnect() : méthode officielle de PeerJS pour ce cas précis —
            // retente une connexion au serveur de signalisation en conservant le MÊME
            // identifiant (le code de salon reste valable), sans avoir besoin de tout
            // recréer. Échoue silencieusement si l'identifiant a entre-temps été repris
            // par quelqu'un d'autre (très improbable en pratique).
            this.signalingOpen = false;
            if (this.peer && !this.peer.destroyed) this.peer.reconnect();
            if (this.handlers.onSignalingDisconnected) this.handlers.onSignalingDisconnected();
        });

        this.peer.on('error', (err) => {
            this._log('Erreur Peer (hôte) :', err.type, err);
            if (this.handlers.onError) this.handlers.onError(err);
        });
    }

    // Rejoint une partie déjà créée via son code à 4 lettres. `metadata` (optionnel) est
    // transmis tel quel à l'hôte via conn.metadata — utilisé par app.js pour porter un
    // jeton de reconnexion stable.
    joinRoom(roomCode, metadata) {
        this.role = 'guest';
        this.maxGuests = 1; // du point de vue d'un invité, il n'y a qu'une connexion : vers l'hôte
        this.roomCode = roomCode.toUpperCase().trim();
        const targetId = PEER_ID_PREFIX + this.roomCode;
        this.peer = new Peer({ config: ICE_CONFIG, debug: 1 });

        this.peer.on('open', () => {
            this._log('Peer invité ouvert, tentative de connexion à', targetId);
            this.signalingOpen = true; // aussi vrai en cas de succès d'un reconnect() après coupure
            const conn = this.peer.connect(targetId, { reliable: true, metadata: metadata || {} });
            this.conns = [conn];
            this._armTimeouts();
            this._wireConnection(conn, 0);
            if (this.handlers.onOpen) this.handlers.onOpen('guest', this.roomCode);
        });

        this.peer.on('disconnected', () => {
            this._log('Peer invité déconnecté du serveur de signalisation, tentative de reconnexion automatique...');
            // Voir échange avec Guillaume : c'est très probablement ce cas précis qui
            // laissait le bouton "🔌 Se reconnecter" ne jamais apparaître. La coupure au
            // niveau du serveur de signalisation (WebSocket) est un événement DIFFÉRENT de
            // la fermeture de la DataConnection p2p (voir onPeerDisconnected) — cette
            // dernière peut mettre du temps à se déclencher, ou ne jamais se déclencher
            // proprement, après une coupure côté signalisation seule. Sans ce relais, rien
            // ne prévenait l'appli que la connexion était compromise.
            // this.peer.reconnect() : méthode officielle de PeerJS pour ce cas précis —
            // retente automatiquement une connexion au serveur de signalisation, en
            // conservant le même jeton PeerJS interne. Si elle aboutit, 'open' se
            // redéclenche ci-dessus et relance une connexion vers l'hôte avec le jeton de
            // reconnexion habituel (metadata.reconnectToken) — l'hôte la traite alors
            // comme un retour normal (voir onGuestConnected), sans que rien de manuel ne
            // soit nécessaire.
            if (this.peer && !this.peer.destroyed) this.peer.reconnect();
            this.signalingOpen = false;
            if (this.handlers.onSignalingDisconnected) this.handlers.onSignalingDisconnected();
        });

        this.peer.on('error', (err) => {
            this._log('Erreur Peer (invité) :', err.type, err);
            this._clearTimers();
            if (this.handlers.onError) this.handlers.onError(err);
        });
    }

    // Envoie un message. Sans guestIndex : diffusé à toutes les connexions actives
    // (utile côté hôte en mode "maître du jeu" pour relayer à tout le monde).
    send(message, guestIndex) {
        if (guestIndex !== undefined) {
            const conn = this.conns[guestIndex];
            if (conn && conn.open) conn.send(message);
            return;
        }
        this.conns.forEach(conn => {
            if (conn && conn.open) conn.send(message);
        });
    }

    // Diffuse à toutes les connexions SAUF celle d'index excludeIndex (utile côté hôte
    // pour relayer le message d'un invité vers l'autre, sans le lui renvoyer à lui-même).
    sendExcept(message, excludeIndex) {
        this.conns.forEach((conn, i) => {
            if (i === excludeIndex) return;
            if (conn && conn.open) conn.send(message);
        });
    }

    isConnected() {
        return this.signalingOpen && this.conns.some(c => c && c.open);
    }

    allConnected() {
        return this.conns.length >= this.maxGuests && this.conns.every(c => c && c.open);
    }

    destroy() {
        this._clearTimers();
        this.conns.forEach(c => c && c.close());
        this.conns = [];
        if (this.peer) this.peer.destroy();
    }
}
