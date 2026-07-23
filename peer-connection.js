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
//   Reprise automatique d'hôte (voir échange avec Guillaume, session du 23 juillet) : si
//   l'hôte disparaît en cours de partie sans revenir, un "sous-hôte" pré-désigné (voir
//   computeSubHostId dans app.js — le partenaire de l'hôte de préférence) recrée
//   automatiquement la salle sous EXACTEMENT le même code (voir createRoom(cap,
//   forcedRoomCode) ci-dessous) après un délai de grâce de 20s (GUEST_TAKEOVER_GRACE_MS
//   dans app.js) sans reconnexion. Les autres participants ne remarquent rien : leur
//   reconnexion habituelle (auto ou bouton manuel) vise déjà ce même code. Si l'ancien
//   hôte revient après coup, il détecte la collision d'identifiant (erreur
//   'unavailable-id') et rejoint lui-même la partie comme simple invité.
//
// Diagnostic : tout ce qui touche à l'établissement de la connexion est aussi loggué en
// console (F12) et dans le panneau de diagnostic à l'écran (préfixe "[peer]").

const PEER_ID_PREFIX = 'bridge-bid-v1-';
const CONNECTION_TIMEOUT_MS = 45000; // au-delà, on considère que ça n'aboutira pas

// Voir échange avec Guillaume ("Lost connection to server" au tout premier essai) : le
// service cloud public et gratuit de PeerJS a, de temps en temps, un aléa transitoire au
// moment précis de s'y enregistrer — sans lien avec le code de salon ni le réseau de la
// personne en particulier. Plutôt que de faire échouer tout de suite, on retente
// automatiquement quelques fois avant d'abandonner pour de bon (voir _attemptCreateRoom/
// _attemptJoinRoom). Uniquement pour la toute première tentative de connexion, jamais une
// fois déjà connecté (ce cas-là est géré séparément par peer.reconnect(), voir 'disconnected').
const MAX_INITIAL_CONNECT_RETRIES = 2; // donc 3 tentatives au total
const INITIAL_CONNECT_RETRY_DELAY_MS = 1500;
// Reconnexions automatiques via peer.reconnect() APRÈS une première connexion réussie
// (voir 'disconnected' dans _attemptCreateRoom/_attemptJoinRoom) : bornées elles aussi,
// par sécurité, au cas où le réseau resterait durablement indisponible même après un
// premier succès — sans quoi ce mécanisme pourrait, comme le bug corrigé avec Guillaume,
// tourner indéfiniment.
const MAX_POST_OPEN_RECONNECT_ATTEMPTS = 5;
// Types d'erreur PeerJS considérés comme transitoires (réseau/serveur), donc valant la
// peine d'être retentés — par opposition à des erreurs de fond qui ne se résoudraient pas
// en réessayant (identifiant invalide, navigateur incompatible...). 'unavailable-id' est
// inclus séparément côté hôte uniquement (voir _attemptCreateRoom) : un nouveau code de
// salon est alors généré à chaque tentative, ce qui résout ce cas précis.
const RETRIABLE_ERROR_TYPES = ['network', 'server-error', 'socket-error', 'socket-closed'];

// Configuration ICE explicite : serveurs STUN publics (Google + Metered, aucun des deux
// n'a besoin d'identifiants), complétés par DEUX fournisseurs TURN indépendants
// (relais qui font réellement transiter les données quand une connexion directe échoue —
// cas fréquent avec les NAT restrictifs, certains pare-feux, le "NAT hairpinning", ou
// l'isolation client d'un partage de connexion mobile) :
//   - ExpressTURN (compte gratuit de Guillaume)
//   - Metered / Open Relay (compte gratuit de Guillaume, identifiant généré depuis son
//     tableau de bord — voir échange avec Guillaume : une première tentative avec des
//     identifiants publics partagés `openrelayproject`/`openrelayproject` avait échoué,
//     ce fournisseur exigeant désormais un vrai compte pour limiter les abus)
// Si l'un des deux est indisponible à un instant donné (quota, panne, limite de débit...),
// la négociation ICE a une vraie chance de réussir quand même via l'autre.
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.relay.metered.ca:80' },
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
        },
        {
            urls: 'turn:standard.relay.metered.ca:80',
            username: '770bea7717c25ad27a475345',
            credential: '2lEc2n+zXAKRFb15'
        },
        {
            urls: 'turn:standard.relay.metered.ca:80?transport=tcp',
            username: '770bea7717c25ad27a475345',
            credential: '2lEc2n+zXAKRFb15'
        },
        {
            urls: 'turn:standard.relay.metered.ca:443',
            username: '770bea7717c25ad27a475345',
            credential: '2lEc2n+zXAKRFb15'
        },
        {
            urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
            username: '770bea7717c25ad27a475345',
            credential: '2lEc2n+zXAKRFb15'
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
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += Math.floor(Math.random() * 10);
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
        // Vrai une fois que 'open' s'est déclenché au moins une fois (voir _attemptCreateRoom/
        // _attemptJoinRoom) : distingue un aléa réseau sur la toute première tentative de
        // connexion (retentée automatiquement, voir plus bas) d'une coupure survenant après
        // coup, une fois déjà bien connecté (gérée séparément par reconnect()/'disconnected').
        this._everOpened = false;
        this._connectRetries = 0;
        this._postOpenReconnectAttempts = 0;
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
    //
    // Voir échange avec Guillaume (session du 23 juillet — reprise automatique d'hôte par
    // le sous-hôte) : `forcedRoomCode`, optionnel, impose un code précis au lieu d'en tirer
    // un nouveau au hasard — nécessaire pour que le sous-hôte puisse reprendre EXACTEMENT
    // le même code que celui de l'hôte disparu (sans quoi les autres participants, dont la
    // reconnexion vise toujours l'ancien code, ne retrouveraient jamais la salle).
    createRoom(cap = 6, forcedRoomCode) {
        this.role = 'host';
        this.maxGuests = cap;
        this._everOpened = false;
        this._connectRetries = 0;
        this._forcedRoomCode = forcedRoomCode || null;
        this._attemptCreateRoom(cap);
    }

    // Une tentative de création, isolée pour pouvoir être rejouée telle quelle en cas
    // d'aléa réseau transitoire (voir RETRIABLE_ERROR_TYPES et le handler 'error' plus bas).
    // Génère un NOUVEAU code à chaque tentative — utile en particulier pour 'unavailable-id'
    // (collision d'identifiant, très improbable mais possible), que ça résout au passage.
    // SAUF si `this._forcedRoomCode` est posé (voir createRoom ci-dessus) : dans ce cas
    // précis, le code reste fixe même d'une tentative à l'autre — un 'unavailable-id' y
    // signifie alors que quelqu'un d'autre détient déjà ce code précis (collision de
    // reprise, voir échange avec Guillaume), pas une simple malchance à contourner en
    // changeant de code.
    _attemptCreateRoom(cap) {
        this.roomCode = this._forcedRoomCode || makeRoomCode();
        const id = PEER_ID_PREFIX + this.roomCode;
        this._log('Création de la partie, id =', id, this._connectRetries ? `(tentative ${this._connectRetries + 1})` : '');
        this.peer = new Peer(id, { config: ICE_CONFIG, debug: 1 });

        this.peer.on('open', () => {
            this._log('Peer hôte ouvert, en attente de connexions...');
            this.signalingOpen = true; // aussi vrai en cas de succès d'un reconnect() après coupure
            this._everOpened = true;
            this._postOpenReconnectAttempts = 0; // nouveau crédit de tentatives à chaque succès
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
            this.signalingOpen = false;
            // Voir le journal de diagnostic de Guillaume (4G, ne marchait toujours pas) :
            // 'disconnected' se déclenche AUSSI pendant la toute première tentative de
            // connexion (en plus de 'error', déjà géré par le retry borné ci-dessous) — un
            // appel à reconnect() ici à ce stade-là entrait en boucle avec ce retry, les
            // deux mécanismes se relançant l'un l'autre indéfiniment, sans jamais
            // s'arrêter ni remonter d'erreur (c'est ce qui produisait le déluge de lignes
            // "Erreur/déconnecté" en boucle dans le journal). Ce reconnect() automatique
            // n'a de sens QUE pour une connexion déjà établie une première fois (le cas
            // qu'il visait à l'origine : coupure après coup, voir plus bas) — pendant la
            // première tentative, on laisse le retry borné de 'error' faire seul son travail.
            if (!this._everOpened) return;
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
            // par quelqu'un d'autre (très improbable en pratique). Bornée elle aussi (voir
            // _postOpenReconnectAttempts) : au cas où le réseau resterait durablement
            // indisponible même après une connexion initiale réussie.
            if (this._postOpenReconnectAttempts >= MAX_POST_OPEN_RECONNECT_ATTEMPTS) {
                this._log('Trop de tentatives de reconnexion automatique après coupure, abandon (voir bouton "Se reconnecter" manuel).');
                if (this.handlers.onSignalingDisconnected) this.handlers.onSignalingDisconnected();
                return;
            }
            this._postOpenReconnectAttempts++;
            if (this.peer && !this.peer.destroyed) this.peer.reconnect();
            if (this.handlers.onSignalingDisconnected) this.handlers.onSignalingDisconnected();
        });

        this.peer.on('error', (err) => {
            this._log('Erreur Peer (hôte) :', err.type, err);
            // Retry uniquement pour la toute première connexion (jamais ouverte ne serait-
            // ce qu'une fois) — passé ce cap, une erreur relève de 'disconnected'/reconnect()
            // ci-dessus, pas de ce mécanisme-ci (voir RETRIABLE_ERROR_TYPES en tête de fichier).
            // Voir échange avec Guillaume (session du 23 juillet) : le retry sur
            // 'unavailable-id' change habituellement de code pour contourner la collision —
            // mais avec un code IMPOSÉ (`_forcedRoomCode`, voir createRoom), ce serait
            // retenter exactement le même code déjà pris, donc futile. Dans ce cas précis,
            // l'erreur remonte tout de suite à l'appelant (voir uiOnSubHostTakeover) plutôt
            // que de gaspiller les tentatives bornées pour rien.
            const canRetry = !this._everOpened && this._connectRetries < MAX_INITIAL_CONNECT_RETRIES
                && (RETRIABLE_ERROR_TYPES.includes(err.type) || (err.type === 'unavailable-id' && !this._forcedRoomCode));
            if (canRetry) {
                this._connectRetries++;
                this._log(`Nouvelle tentative de création (${this._connectRetries}/${MAX_INITIAL_CONNECT_RETRIES}) dans ${INITIAL_CONNECT_RETRY_DELAY_MS}ms...`);
                if (this.peer && !this.peer.destroyed) this.peer.destroy();
                setTimeout(() => this._attemptCreateRoom(cap), INITIAL_CONNECT_RETRY_DELAY_MS);
                return;
            }
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
        this._everOpened = false;
        this._connectRetries = 0;
        this._attemptJoinRoom(metadata);
    }

    // Une tentative de connexion, isolée pour pouvoir être rejouée telle quelle en cas
    // d'aléa réseau transitoire au moment de s'enregistrer auprès du serveur de
    // signalisation (voir RETRIABLE_ERROR_TYPES et le handler 'error' plus bas) — le code
    // de salon, lui, ne change pas d'une tentative à l'autre (contrairement à
    // _attemptCreateRoom côté hôte).
    _attemptJoinRoom(metadata) {
        const targetId = PEER_ID_PREFIX + this.roomCode;
        this.peer = new Peer({ config: ICE_CONFIG, debug: 1 });

        this.peer.on('open', () => {
            this._log('Peer invité ouvert, tentative de connexion à', targetId);
            this.signalingOpen = true; // aussi vrai en cas de succès d'un reconnect() après coupure
            this._everOpened = true;
            this._postOpenReconnectAttempts = 0; // nouveau crédit de tentatives à chaque succès
            const conn = this.peer.connect(targetId, { reliable: true, metadata: metadata || {} });
            this.conns = [conn];
            this._armTimeouts();
            this._wireConnection(conn, 0);
            if (this.handlers.onOpen) this.handlers.onOpen('guest', this.roomCode);
        });

        this.peer.on('disconnected', () => {
            this.signalingOpen = false;
            // Voir le correctif symétrique côté hôte (_attemptCreateRoom) : même bug de
            // boucle infinie possible ici pendant la toute première tentative de
            // connexion, pour la même raison (reconnect() ici entrant en conflit avec le
            // retry borné de 'error'). On ne tente ce reconnect() automatique qu'après une
            // première ouverture réussie.
            if (!this._everOpened) return;
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
            // soit nécessaire. Bornée (voir _postOpenReconnectAttempts) : au cas où le
            // réseau resterait durablement indisponible.
            if (this._postOpenReconnectAttempts >= MAX_POST_OPEN_RECONNECT_ATTEMPTS) {
                this._log('Trop de tentatives de reconnexion automatique après coupure, abandon (voir bouton "Se reconnecter" manuel).');
                if (this.handlers.onSignalingDisconnected) this.handlers.onSignalingDisconnected();
                return;
            }
            this._postOpenReconnectAttempts++;
            if (this.peer && !this.peer.destroyed) this.peer.reconnect();
            if (this.handlers.onSignalingDisconnected) this.handlers.onSignalingDisconnected();
        });

        this.peer.on('error', (err) => {
            this._log('Erreur Peer (invité) :', err.type, err);
            // Retry uniquement pour la toute première connexion (jamais ouverte ne serait-
            // ce qu'une fois) — passé ce cap, une erreur relève de 'disconnected'/reconnect()
            // ci-dessus, pas de ce mécanisme-ci. Contrairement à l'hôte, pas de cas
            // 'unavailable-id' possible ici : ce Peer n'a pas d'identifiant imposé.
            const canRetry = !this._everOpened && this._connectRetries < MAX_INITIAL_CONNECT_RETRIES
                && RETRIABLE_ERROR_TYPES.includes(err.type);
            if (canRetry) {
                this._connectRetries++;
                this._log(`Nouvelle tentative de connexion (${this._connectRetries}/${MAX_INITIAL_CONNECT_RETRIES}) dans ${INITIAL_CONNECT_RETRY_DELAY_MS}ms...`);
                if (this.peer && !this.peer.destroyed) this.peer.destroy();
                setTimeout(() => this._attemptJoinRoom(metadata), INITIAL_CONNECT_RETRY_DELAY_MS);
                return;
            }
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

    // Voir échange avec Guillaume (session du 23 juillet — "le bouton Se reconnecter ne
    // marchait pas côté hôte") : réutilise le MÊME objet Peer (même identifiant déjà
    // enregistré) plutôt que de le détruire pour en recréer un nouveau sous le même code
    // (voir createRoom(cap, forcedRoomCode)) — cette dernière approche ouvrait une course
    // avec le serveur de signalisation PeerJS : rien ne garantit qu'il ait fini de libérer
    // l'identifiant de l'ancien Peer au moment précis où le nouveau tente de s'enregistrer
    // sous ce même identifiant, provoquant un échec 'unavailable-id' évitable. reconnect()
    // ici retente sous la MÊME session déjà connue du serveur, sans cette course.
    // _postOpenReconnectAttempts remis à zéro : un clic manuel mérite un nouveau crédit de
    // tentatives, indépendant du plafond des tentatives automatiques déjà épuisées.
    manualReconnect() {
        if (!this.peer || this.peer.destroyed) return false;
        this._postOpenReconnectAttempts = 0;
        this.peer.reconnect();
        return true;
    }

    destroy() {
        this._clearTimers();
        this.conns.forEach(c => c && c.close());
        this.conns = [];
        if (this.peer) this.peer.destroy();
    }
}
