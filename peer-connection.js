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
//   Reprise d'hôte : il n'existe plus d'élection automatique d'un autre participant. Le
//   vrai hôte peut recréer la salle sous le même code via `forcedRoomCode`. Pendant une
//   absence, les participants authentifiés utilisent le relais cloud pour leurs propres
//   actions ; ils ne deviennent pas hôte P2P par simple expiration d'un délai.
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

// PeerJS n'est plus un <script> bloquant de l'écran d'accueil. Il est chargé seulement
// au premier Create/Join, depuis une version figée 1.5.4. Deux CDN indépendants sont
// tentés : une panne/lenteur d'unpkg ne doit plus rendre PLAY inutilisable.
const PEERJS_SCRIPT_URLS = [
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js'
];
let peerJsLoadPromise = null;

function peerPerf(name, detail) {
    try {
        if (typeof window !== 'undefined' && typeof window.recordPlayPerfMilestone === 'function') {
            window.recordPlayPerfMilestone(name, detail);
        }
    } catch (e) { /* diagnostic seulement */ }
}

function loadExternalPeerScript(url, attempt) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.peerjsLoader = String(attempt);
        let settled = false;
        const timer = setTimeout(() => finish(false, new Error('PeerJS CDN timeout')), 20000);
        const finish = (ok, err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (ok && typeof Peer !== 'undefined') resolve(Peer);
            else {
                script.remove();
                reject(err || new Error('PeerJS global absent après chargement'));
            }
        };
        script.addEventListener('load', () => finish(true), { once: true });
        script.addEventListener('error', () => finish(false, new Error('PeerJS CDN indisponible')), { once: true });
        document.head.appendChild(script);
    });
}

async function ensurePeerJsReady() {
    if (typeof Peer !== 'undefined') return Peer;
    if (peerJsLoadPromise) return peerJsLoadPromise;
    peerJsLoadPromise = (async () => {
        peerPerf('peerjs-load-start');
        let lastError;
        for (let i = 0; i < PEERJS_SCRIPT_URLS.length; i++) {
            try {
                const value = await loadExternalPeerScript(PEERJS_SCRIPT_URLS[i], i);
                peerPerf('peerjs-load-ready', { source: i === 0 ? 'unpkg' : 'cdnjs' });
                return value;
            } catch (err) {
                lastError = err;
                peerPerf('peerjs-load-source-failed', { source: i === 0 ? 'unpkg' : 'cdnjs' });
            }
        }
        throw lastError || new Error('PeerJS indisponible');
    })().catch(err => {
        peerJsLoadPromise = null; // permet une vraie retentative ultérieure
        throw err;
    });
    return peerJsLoadPromise;
}

// Voir échange avec Guillaume (session du 23 juillet — "rien ne se passe après
// 'disconnected'") : délai de tolérance avant de fermer nous-mêmes une connexion dont
// l'état ICE reste bloqué en 'disconnected'/'failed' sans jamais se rétablir tout seul
// (voir attachPCDiagnostics ci-dessous) — assez court pour ne pas retarder inutilement la
// détection, tout en restant assez long pour laisser ICE récupérer seul d'un
// blip vraiment bref sans qu'on lui coupe l'herbe sous le pied.
const ICE_STUCK_TIMEOUT_MS = 6000;
// Types d'erreur PeerJS considérés comme transitoires (réseau/serveur), donc valant la
// peine d'être retentés — par opposition à des erreurs de fond qui ne se résoudraient pas
// en réessayant (identifiant invalide, navigateur incompatible...). 'unavailable-id' est
// inclus séparément côté hôte uniquement (voir _attemptCreateRoom) : un nouveau code de
// salon est alors généré à chaque tentative, ce qui résout ce cas précis.
const RETRIABLE_ERROR_TYPES = ['network', 'server-error', 'socket-error', 'socket-closed'];

// R127 — les mots de passe TURN permanents ne sont plus publiés dans ce fichier.
// Les STUN publics restent statiques (aucun secret). Les relais TURN sont obtenus à la
// demande depuis API-gen sous forme de credentials temporaires. Ils sont gardés uniquement
// en mémoire et rafraîchis automatiquement lors d'une nouvelle création/reconnexion P2P.
// La durée d'une SALLE n'a aucun lien avec celle d'un credential TURN : rouvrir PLAY des
// heures plus tard provoque simplement l'obtention d'un nouveau credential.
const STATIC_STUN_SERVERS = Object.freeze([
    Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
    Object.freeze({ urls: 'stun:stun1.l.google.com:19302' }),
    Object.freeze({ urls: 'stun:stun2.l.google.com:19302' }),
    Object.freeze({ urls: 'stun:stun.relay.metered.ca:80' })
]);
const TURN_CREDENTIALS_ENDPOINT = 'https://api-gen-beta.vercel.app/api/turn-credentials';
const TURN_CREDENTIAL_FETCH_TIMEOUT_MS = 4000;
const TURN_CREDENTIAL_REFRESH_SKEW_MS = 30 * 60 * 1000;
let temporaryIceCache = null;
let temporaryIceFetchPromise = null;

function cloneIceServers(rows) {
    return (Array.isArray(rows) ? rows : []).map(row => ({
        urls: Array.isArray(row.urls) ? row.urls.slice() : row.urls,
        ...(typeof row.username === 'string' ? { username: row.username } : {}),
        ...(typeof row.credential === 'string' ? { credential: row.credential } : {})
    }));
}

function staticStunConfig() {
    return { iceServers: cloneIceServers(STATIC_STUN_SERVERS) };
}

function normalizeTemporaryIceServers(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const urlsRaw = Array.isArray(raw.urls) ? raw.urls : [raw.urls];
        const urls = urlsRaw
            .filter(url => typeof url === 'string' && /^(?:stun|turn|turns):/i.test(url.trim()))
            .map(url => url.trim());
        if (!urls.length) continue;
        const isTurn = urls.some(url => /^turns?:/i.test(url));
        const username = typeof raw.username === 'string' ? raw.username.trim() : '';
        const credential = typeof raw.credential === 'string' ? raw.credential : '';
        if (isTurn && (!username || !credential)) continue;
        const key = JSON.stringify([urls, username, credential]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            urls: urls.length === 1 ? urls[0] : urls,
            ...(username ? { username } : {}),
            ...(credential ? { credential } : {})
        });
    }
    return out;
}

function temporaryTurnCacheUsable(roomCode, now = Date.now()) {
    return !!(temporaryIceCache
        && temporaryIceCache.roomCode === String(roomCode || '').toUpperCase().trim()
        && Number.isFinite(temporaryIceCache.expiresAt)
        && temporaryIceCache.expiresAt - now > TURN_CREDENTIAL_REFRESH_SKEW_MS
        && Array.isArray(temporaryIceCache.iceServers)
        && temporaryIceCache.iceServers.some(row => {
            const urls = Array.isArray(row.urls) ? row.urls : [row.urls];
            return urls.some(url => /^turns?:/i.test(String(url || '')));
        }));
}

async function ensureFreshIceConfig(roomCode, force = false) {
    const normalizedRoom = String(roomCode || '').toUpperCase().trim();
    if (!normalizedRoom || (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:')) {
        return staticStunConfig();
    }
    if (!force && temporaryTurnCacheUsable(normalizedRoom)) {
        peerPerf('turn-credential-cache-hit', { roomCode: normalizedRoom });
        return { iceServers: cloneIceServers(STATIC_STUN_SERVERS).concat(cloneIceServers(temporaryIceCache.iceServers)) };
    }
    if (!force && temporaryIceFetchPromise && temporaryIceFetchPromise.roomCode === normalizedRoom) {
        return temporaryIceFetchPromise.promise;
    }

    const promise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TURN_CREDENTIAL_FETCH_TIMEOUT_MS);
        try {
            peerPerf('turn-credential-fetch-start', { roomCode: normalizedRoom });
            const url = `${TURN_CREDENTIALS_ENDPOINT}?code=${encodeURIComponent(normalizedRoom)}`;
            const response = await fetch(url, { method: 'POST', cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error(`TURN HTTP ${response.status}`);
            const body = await response.json();
            const iceServers = normalizeTemporaryIceServers(body && body.iceServers);
            const expiresAt = Number(body && body.expiresAt);
            if (!iceServers.some(row => {
                const urls = Array.isArray(row.urls) ? row.urls : [row.urls];
                return urls.some(item => /^turns?:/i.test(String(item || '')));
            }) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
                throw new Error('Réponse TURN temporaire invalide');
            }
            temporaryIceCache = { roomCode: normalizedRoom, expiresAt, iceServers };
            peerPerf('turn-credential-ready', {
                roomCode: normalizedRoom,
                expiresInSec: Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
            });
            return { iceServers: cloneIceServers(STATIC_STUN_SERVERS).concat(cloneIceServers(iceServers)) };
        } catch (err) {
            // Ne jamais rendre Create/Join impossible uniquement parce que le broker TURN
            // est momentanément indisponible. STUN/direct reste utilisable ; si le réseau
            // exige absolument un relais, la reconnexion complète suivante retentera le
            // broker et récupérera de nouveaux credentials.
            const reason = controller.signal.aborted ? 'timeout' : ((err && err.message) || String(err));
            peerPerf('turn-credential-fallback-stun', { roomCode: normalizedRoom, reason });
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[peer] Credentials TURN temporaires indisponibles, tentative STUN/direct uniquement :', reason);
            }
            return staticStunConfig();
        } finally {
            clearTimeout(timer);
        }
    })();
    if (!force) temporaryIceFetchPromise = { roomCode: normalizedRoom, promise };
    try {
        return await promise;
    } finally {
        if (!force && temporaryIceFetchPromise && temporaryIceFetchPromise.promise === promise) temporaryIceFetchPromise = null;
    }
}

// Test isolé : force tout le trafic à passer par TURN (iceTransportPolicy:'relay').
// Contrairement aux anciennes releases, ce test récupère d'abord un credential frais :
// aucun mot de passe permanent n'est contenu dans le bundle public.
async function testTurnConnectivity() {
    const log = (typeof pushDebugLog === 'function') ? pushDebugLog : (s => console.log(s));
    log('--- Test TURN isolé (credentials temporaires, iceTransportPolicy=relay) ---');

    const roomCode = (typeof currentRoomCode !== 'undefined' && currentRoomCode) ? currentRoomCode : null;
    if (!roomCode) {
        log('Test TURN — aucune salle active : impossible de demander un credential temporaire.');
        return;
    }
    const config = await ensureFreshIceConfig(roomCode, true);
    const turnServers = (config.iceServers || []).filter(row => {
        const urls = Array.isArray(row.urls) ? row.urls : [row.urls];
        return urls.some(url => /^turns?:/i.test(String(url || '')));
    });
    if (!turnServers.length) {
        log('Test TURN — aucun credential TURN temporaire disponible (STUN/direct seulement).');
        return;
    }

    const pc = new RTCPeerConnection({ iceServers: turnServers, iceTransportPolicy: 'relay' });
    let gotRelay = false;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            log('Test TURN — candidat reçu, type = ' + (event.candidate.type || '?'));
            if (event.candidate.type === 'relay') gotRelay = true;
        } else {
            log('Test TURN — récolte terminée. Résultat : ' + (gotRelay ? '✅ TURN temporaire joignable !' : '❌ Aucun relais obtenu.'));
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
        this._hostOpenTimeoutId = null;
        this._settled = false; // vrai une fois au moins une connexion établie (désarme les timeouts)
        // Vrai tant que la connexion au serveur de signalisation PeerJS tient (voir
        // isConnected ci-dessous et l'événement 'disconnected' dans createRoom/joinRoom) :
        // distinct de l'état ouvert/fermé des DataConnection p2p elles-mêmes, qui peuvent
        // rester "ouvertes" un moment après une coupure côté signalisation.
        // Faux tant que PeerJS n'a pas réellement émis `open` : une tentative en cours
        // n'est pas encore une signalisation rétablie.
        this.signalingOpen = false;
        // Vrai une fois que 'open' s'est déclenché au moins une fois (voir _attemptCreateRoom/
        // _attemptJoinRoom) : distingue un aléa réseau sur la toute première tentative de
        // connexion (retentée automatiquement, voir plus bas) d'une coupure survenant après
        // coup, une fois déjà bien connecté (gérée séparément par reconnect()/'disconnected').
        this._everOpened = false;
        this._connectRetries = 0;
        this._postOpenReconnectAttempts = 0;
        // Invalide une réservation de code encore en vol si la création est relancée ou
        // détruite avant que le serveur ait répondu.
        this._roomCreateGeneration = 0;
        // Même garde côté invité : _attemptJoinRoom contient un await (chargement PeerJS).
        // Si destroy() survient pendant cet await (notamment au timeout global R37), la
        // continuation tardive ne doit surtout pas recréer un Peer en arrière-plan.
        this._roomJoinGeneration = 0;
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
        if (this._hostOpenTimeoutId) { clearTimeout(this._hostOpenTimeoutId); this._hostOpenTimeoutId = null; }
    }

    _clearHostOpenTimeout() {
        if (this._hostOpenTimeoutId) {
            clearTimeout(this._hostOpenTimeoutId);
            this._hostOpenTimeoutId = null;
        }
    }

    // Timeout global de création/reprise hôte, limité à l'ouverture de la signalisation.
    // Un hôte seul dans son salon est parfaitement valide : on ne peut donc pas réutiliser
    // le timeout des DataConnections invitées. Ce watchdog couvre réservation du code,
    // chargement PeerJS et WebSocket, puis se désarme au vrai événement `open`.
    _armHostOpenTimeout(generation) {
        this._clearHostOpenTimeout();
        this._hostOpenTimeoutId = setTimeout(() => {
            this._hostOpenTimeoutId = null;
            if (generation !== this._roomCreateGeneration || this._everOpened) return;
            this._log('Délai dépassé (45s) avant ouverture de la signalisation hôte : abandon.');
            this.signalingOpen = false;
            // Invalide aussi un await encore suspendu : sa continuation pourra finir plus
            // tard, mais ne pourra plus recréer un Peer fantôme après cet abandon.
            this._roomCreateGeneration++;
            const stalePeer = this.peer;
            this.peer = null;
            if (stalePeer && !stalePeer.destroyed) {
                try { stalePeer.destroy(); } catch (e) { /* abandon best-effort */ }
            }
            if (this.handlers.onHostOpenTimeout) this.handlers.onHostOpenTimeout();
        }, CONNECTION_TIMEOUT_MS);
    }

    _wireConnection(conn, guestIndex) {
        conn.on('data', (msg) => {
            if (this.handlers.onData) this.handlers.onData(msg, guestIndex);
        });

        conn.on('close', () => {
            this._log(`DataConnection #${guestIndex} fermée`);
            // Une connexion remplacée dans le même créneau peut fermer quelques ms APRÈS
            // sa remplaçante. Cette fermeture obsolète ne doit pas annoncer la nouvelle
            // connexion comme déconnectée. Même règle pour un destroy() volontaire.
            const wasCurrent = this.conns[guestIndex] === conn;
            if (wasCurrent) {
                this.conns[guestIndex] = null;
                if (this.handlers.onPeerDisconnected) this.handlers.onPeerDisconnected(guestIndex);
            } else {
                this._log(`DataConnection #${guestIndex} déjà remplacée — fermeture tardive ignorée.`);
            }
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
            // Voir échange avec Guillaume (session du 23 juillet — "rien ne se passe après
            // 'disconnected'") : un Wi-Fi qui vacille peut dégrader la connexion ICE
            // sous-jacente sans jamais déclencher conn.close() ni la coupure du serveur de
            // signalisation (les deux seuls événements dont dépendait jusqu'ici toute la
            // mécanique de reconnexion, voir onPeerDisconnected/onSignalingDisconnected) —
            // laissant l'appli bloquée dans les limbes, persuadée que tout va bien. Ce
            // minuteur ferme nous-mêmes la connexion (déclenchant alors le vrai
            // conn.close(), donc toute la mécanique existante) si l'état ICE reste
            // bloqué en 'disconnected' ou 'failed' plus de ICE_STUCK_TIMEOUT_MS SANS être
            // revenu à 'connected'/'completed' entre-temps — un blip très bref, qu'ICE
            // rattrape presque toujours tout seul en quelques secondes, ne déclenche donc
            // jamais rien ici.
            let iceStuckTimer = null;
            pc.addEventListener('iceconnectionstatechange', () => {
                this._log(`[#${guestIndex}] État ICE (peerConnection) :`, pc.iceConnectionState);
                const state = pc.iceConnectionState;
                if (state === 'disconnected' || state === 'failed') {
                    if (!iceStuckTimer) {
                        iceStuckTimer = setTimeout(() => {
                            iceStuckTimer = null;
                            const stillStuck = pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed';
                            if (stillStuck && this.conns[guestIndex] === conn) {
                                this._log(`[#${guestIndex}] ICE bloqué en '${pc.iceConnectionState}' depuis ${ICE_STUCK_TIMEOUT_MS / 1000}s — fermeture forcée de la connexion.`);
                                conn.close(); // déclenche le conn.on('close', ...) déjà câblé plus haut
                            }
                        }, ICE_STUCK_TIMEOUT_MS);
                    }
                } else if (iceStuckTimer) {
                    // Rétabli tout seul avant l'échéance (voir 'connected'/'completed') :
                    // annule, rien à faire — c'est exactement le cas qu'on veut laisser
                    // ICE gérer sans intervenir.
                    clearTimeout(iceStuckTimer);
                    iceStuckTimer = null;
                }
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
    // `forcedRoomCode`, optionnel, impose un code précis au lieu d'en tirer un nouveau :
    // il sert à la reconnexion/reprise volontaire du vrai hôte sous le même code de salle.
    createRoom(cap = 6, forcedRoomCode) {
        this.role = 'host';
        this.maxGuests = cap;
        this._everOpened = false;
        this._connectRetries = 0;
        this._settled = false;
        this.signalingOpen = false;
        this._forcedRoomCode = forcedRoomCode || null;
        const generation = ++this._roomCreateGeneration;
        this._armHostOpenTimeout(generation);
        this._attemptCreateRoom(cap, generation);
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
    async _attemptCreateRoom(cap, generation = this._roomCreateGeneration) {
        // Réservation Vercel/Redis et téléchargement de PeerJS sont indépendants : on les
        // lance en parallèle pour que le clic « Créer » paie le MAX des deux délais, pas
        // leur somme. Sur une reprise forcée, seul PeerJS est nécessaire.
        peerPerf('create-attempt-start', { retry: this._connectRetries });
        const peerReadyPromise = ensurePeerJsReady();
        const roomCodePromise = this._forcedRoomCode
            ? Promise.resolve(this._forcedRoomCode)
            : (typeof reserveFreshRoomCode === 'function'
                ? reserveFreshRoomCode()
                : Promise.resolve(makeRoomCode()));
        let nextRoomCode;
        let iceConfig;
        try {
            [nextRoomCode] = await Promise.all([roomCodePromise, peerReadyPromise]);
            if (generation !== this._roomCreateGeneration) return;
            iceConfig = await ensureFreshIceConfig(nextRoomCode);
        } catch (err) {
            if (generation !== this._roomCreateGeneration) return;
            const peerFailed = typeof Peer === 'undefined';
            this._log(peerFailed ? 'Chargement PeerJS impossible :' : 'Réservation du code de salle impossible :', err);
            if (this.handlers.onError) {
                this.handlers.onError({
                    type: peerFailed ? 'peer-library-load-failed' : 'room-code-reservation-failed',
                    message: peerFailed
                        ? 'Impossible de charger le module de connexion. Vérifiez le réseau puis réessayez.'
                        : 'Impossible de réserver un code de salle libre. Réessayez dans un instant.',
                    cause: err
                });
            }
            return;
        }
        if (generation !== this._roomCreateGeneration) return;
        peerPerf('create-room-code-ready', { code: nextRoomCode });
        this.roomCode = nextRoomCode;
        const id = PEER_ID_PREFIX + this.roomCode;
        this._log('Création de la partie, id =', id, this._connectRetries ? `(tentative ${this._connectRetries + 1})` : '');
        peerPerf('peer-signaling-start', { role: 'host' });
        this.peer = new Peer(id, { config: iceConfig, debug: 1 });

        this.peer.on('open', () => {
            if (generation !== this._roomCreateGeneration) return;
            this._clearHostOpenTimeout();
            peerPerf('peer-signaling-open', { role: 'host' });
            this._log('Peer hôte ouvert, en attente de connexions...');
            this.signalingOpen = true; // aussi vrai en cas de succès d'un reconnect() après coupure
            this._everOpened = true;
            this._postOpenReconnectAttempts = 0; // nouveau crédit de tentatives à chaque succès
            if (this.handlers.onOpen) this.handlers.onOpen('host', this.roomCode);
        });

        this.peer.on('connection', (conn) => {
            if (generation !== this._roomCreateGeneration) {
                try { conn.close(); } catch (e) {}
                return;
            }
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
            if (generation !== this._roomCreateGeneration) return;
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
            if (generation !== this._roomCreateGeneration) return;
            this._log('Erreur Peer (hôte) :', err.type, err);
            // Retry uniquement pour la toute première connexion (jamais ouverte ne serait-
            // ce qu'une fois) — passé ce cap, une erreur relève de 'disconnected'/reconnect()
            // ci-dessus, pas de ce mécanisme-ci (voir RETRIABLE_ERROR_TYPES en tête de fichier).
            // Voir échange avec Guillaume (session du 23 juillet) : le retry sur
            // 'unavailable-id' change habituellement de code pour contourner la collision —
            // mais avec un code IMPOSÉ (`_forcedRoomCode`, voir createRoom), ce serait
            // retenter exactement le même code déjà pris, donc futile. Dans ce cas précis,
            // l'erreur remonte tout de suite à l'appelant plutôt que de gaspiller les
            // tentatives bornées pour rien.
            const canRetry = !this._everOpened && this._connectRetries < MAX_INITIAL_CONNECT_RETRIES
                && (RETRIABLE_ERROR_TYPES.includes(err.type) || (err.type === 'unavailable-id' && !this._forcedRoomCode));
            if (canRetry) {
                this._connectRetries++;
                this._log(`Nouvelle tentative de création (${this._connectRetries}/${MAX_INITIAL_CONNECT_RETRIES}) dans ${INITIAL_CONNECT_RETRY_DELAY_MS}ms...`);
                if (this.peer && !this.peer.destroyed) this.peer.destroy();
                setTimeout(() => this._attemptCreateRoom(cap, generation), INITIAL_CONNECT_RETRY_DELAY_MS);
                return;
            }
            this._clearHostOpenTimeout();
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
        this._settled = false;
        this.signalingOpen = false;

        // R37 — timeout GLOBAL de connexion invité : il doit commencer dès l'appel à
        // joinRoom(), AVANT le chargement éventuel de PeerJS et AVANT l'ouverture du
        // WebSocket de signalisation. Jusqu'ici _armTimeouts() n'était appelé que dans
        // peer.on('open') : si PeerJS restait bloqué entre la création du Peer et cet
        // événement (ni 'open' ni 'error'), aucun chrono de 45 s n'existait réellement et
        // l'interface pouvait mouliner indéfiniment sur « Connexion en cours… ».
        // Le même chrono couvre maintenant : chargement PeerJS + signalisation + retries +
        // négociation WebRTC. Une réussite ou une erreur définitive le désarme via les
        // chemins _wireConnection/_clearTimers déjà existants.
        this._clearTimers();
        this._armTimeouts();
        const generation = ++this._roomJoinGeneration;
        this._attemptJoinRoom(metadata, generation);
    }

    // Une tentative de connexion, isolée pour pouvoir être rejouée telle quelle en cas
    // d'aléa réseau transitoire au moment de s'enregistrer auprès du serveur de
    // signalisation (voir RETRIABLE_ERROR_TYPES et le handler 'error' plus bas) — le code
    // de salon, lui, ne change pas d'une tentative à l'autre (contrairement à
    // _attemptCreateRoom côté hôte).
    async _attemptJoinRoom(metadata, generation = this._roomJoinGeneration) {
        if (generation !== this._roomJoinGeneration) return;
        const targetId = PEER_ID_PREFIX + this.roomCode;
        let iceConfig;
        try {
            [, iceConfig] = await Promise.all([
                ensurePeerJsReady(),
                ensureFreshIceConfig(this.roomCode)
            ]);
            if (generation !== this._roomJoinGeneration) return; // détruit/annulé pendant le await
        } catch (err) {
            if (generation !== this._roomJoinGeneration) return;
            this._log('Chargement PeerJS impossible :', err);
            if (this.handlers.onError) this.handlers.onError({
                type: 'peer-library-load-failed',
                message: 'Impossible de charger le module de connexion. Vérifiez le réseau puis réessayez.',
                cause: err
            });
            return;
        }
        peerPerf('peer-signaling-start', { role: 'guest' });
        this.peer = new Peer({ config: iceConfig, debug: 1 });

        this.peer.on('open', () => {
            if (generation !== this._roomJoinGeneration) return;
            peerPerf('peer-signaling-open', { role: 'guest' });
            this._log('Peer invité ouvert, tentative de connexion à', targetId);
            const isSignalingReconnect = this._everOpened;
            this.signalingOpen = true; // aussi vrai en cas de succès d'un reconnect() après coupure
            this._everOpened = true;
            this._postOpenReconnectAttempts = 0; // nouveau crédit de tentatives à chaque succès

            // Une reconnexion de SIGNALISATION peut réussir alors que le canal WebRTC
            // direct n'est jamais tombé. Dans ce cas, ne pas créer un deuxième canal : la
            // fermeture tardive du premier pourrait sinon faire croire que le nouveau vient
            // de se déconnecter. On conserve le canal vivant et on notifie simplement l'app.
            const existingConn = this.conns[0];
            if (existingConn && existingConn.open) {
                this._settled = true;
                this._clearTimers();
                this._log('Signalisation invitée rétablie, DataConnection existante conservée.');
                if (this.handlers.onGuestConnected) this.handlers.onGuestConnected(0, existingConn.metadata || {});
                if (this.handlers.onPeerConnected) this.handlers.onPeerConnected(0);
                if (this.handlers.onOpen) this.handlers.onOpen('guest', this.roomCode);
                return;
            }
            if (existingConn) {
                this.conns = [];
                try { existingConn.close(); } catch (e) {}
            }
            // Sur une réouverture de signalisation après une connexion historique, les
            // timeouts initiaux ont déjà été désarmés. Donner au nouveau canal son propre
            // délai borné évite alors un état intermédiaire sans aucune échéance. Sur le
            // tout premier join, on garde au contraire le chrono GLOBAL démarré avant
            // PeerJS (R37), sans le remettre à zéro ici.
            if (isSignalingReconnect) {
                this._clearTimers();
                this._armTimeouts();
            }
            const conn = this.peer.connect(targetId, { reliable: true, metadata: metadata || {} });
            this.conns = [conn];
            this._wireConnection(conn, 0);
            if (this.handlers.onOpen) this.handlers.onOpen('guest', this.roomCode);
        });

        this.peer.on('disconnected', () => {
            if (generation !== this._roomJoinGeneration) return;
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
            if (generation !== this._roomJoinGeneration) return;
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
                setTimeout(() => this._attemptJoinRoom(metadata, generation), INITIAL_CONNECT_RETRY_DELAY_MS);
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
        this._roomCreateGeneration++;
        this._roomJoinGeneration++;
        this._clearTimers();
        this.signalingOpen = false;
        // Détacher d'abord les références courantes, PUIS fermer. Si PeerJS émet `close`
        // synchroniquement pendant c.close(), ces canaux sont déjà identifiés comme
        // volontairement abandonnés et ne génèrent aucun faux événement de présence.
        const connsToClose = this.conns.slice();
        this.conns = [];
        connsToClose.forEach(c => { try { if (c) c.close(); } catch (e) {} });
        const peerToDestroy = this.peer;
        this.peer = null;
        if (peerToDestroy) {
            try { peerToDestroy.destroy(); } catch (e) {}
        }
    }
}

// Voir échange avec Guillaume (session asynchrone à deux — "on n'est plus obligé de passer
// par le P2P") : implémente EXACTEMENT la même interface publique que BridgePeerConnection
// (send/sendExcept/destroy/isConnected/manualReconnect/conns/signalingOpen), mais sans
// jamais contacter le serveur de signalisation PeerJS ni ouvrir la moindre connexion —
// aucun invité ne peut se relier à une session qui utilise ce stub, et c'est voulu :
// personne d'autre n'est censé en attendre une pendant une reprise purement asynchrone.
//
// Utilisé UNIQUEMENT par uiResumeFromCloud() (app.js), à la place de
// `new BridgePeerConnection(...)` + `createRoom()`. Grâce à cette interface identique,
// aucun des nombreux appels `peerConn.send(...)` / `peerConn.isConnected()` / etc. déjà
// disséminés dans app.js (mode live, inchangé) n'a besoin d'être modifié ou protégé par un
// test supplémentaire : ils continuent de s'exécuter tels quels, et ne font simplement plus
// rien de concret ici, faute d'interlocuteur.
class NullPeerConnection {
    constructor() {
        this.conns = [];
        this.role = 'host';
        this.roomCode = null;
        this.signalingOpen = true; // jamais "déconnecté" : il n'y a rien à connecter
    }
    send() { /* personne à qui parler */ }
    sendExcept() { /* personne à qui parler */ }
    isConnected() { return true; } // pas de bannière "reconnexion" à afficher pour un rôle qui n'a jamais été 'guest' ici
    manualReconnect() { return false; } // rien à reconnecter
    destroy() { /* rien à fermer */ }
    createRoom() { /* jamais appelé : voir uiResumeFromCloud, qui instancie directement ce stub */ }
    joinRoom() { /* idem */ }
}
