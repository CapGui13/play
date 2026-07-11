// app.js — État de l'application et rendu de l'interface.
// S'appuie sur bidding-rules.js (logique pure), deal-parser.js (lecture PBN/LIN)
// et peer-connection.js (connexion WebRTC) chargés avant ce fichier.
//
// PRINCIPE : plus de "modes" prédéfinis. L'hôte crée une partie, atterrit dans un salon
// où apparaissent au fil de l'eau les participants (chacun choisit son pseudo), et
// assigne librement chaque siège (Nord/Est/Sud/Ouest) à qui il veut — y compris la même
// personne sur 2 sièges. Un siège non assigné est joué par un robot qui passe
// systématiquement. Ce mécanisme unique permet de reproduire tous les cas de figure :
// binôme (2 sièges assignés, 2 en robot), diagonale, "maître du jeu" (une personne sur
// 2 sièges, deux autres sur les 2 restants), 4 joueurs (chacun un siège), etc.
//
// TOPOLOGIE : à partir de 2 invités, les invités ne sont jamais connectés entre eux —
// l'hôte relaie tout message reçu d'un invité vers les autres (voir relayIfHost).

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLASSES = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SEAT_FULL_NAME = { N: 'Nord', E: 'Est', S: 'Sud', W: 'Ouest' };
// Abréviation d'un seul caractère à afficher (convention française : O, pas W) — les
// clés internes restent N/E/S/W partout ailleurs (PBN, protocole réseau, etc.).
const SEAT_ABBR_FR = { N: 'N', E: 'E', S: 'S', W: 'O' };
const VULN_LABEL = { None: 'Non vulnérable', NS: 'NS vulnérable', EW: 'EO vulnérable', Both: 'Tous vulnérables' };

let peerConn = null;
let myRole = null;          // 'host' | 'guest'
let myParticipantId = null; // 'host', ou le jeton de reconnexion de l'invité (stable entre reconnexions)
let participants = [];      // [{ id, name, disconnected }, ...] — état du salon, maintenu par l'hôte
let seatAssignment = { N: null, E: null, S: null, W: null }; // id de participant, ou null (robot)
let currentRoomCode = null; // pour uiReconnect() : on doit se souvenir du code utilisé pour rejoindre

// (Hôte uniquement) jeton de reconnexion -> numéro de connexion PeerJS actif. Un invité
// garde le même jeton (localStorage) à travers ses reconnexions, mais son guestIndex
// change à chaque fois (nouvelle connexion PeerJS) : cette table fait le pont entre les
// deux, pour que seatAssignment (qui référence le jeton, stable) reste valide.
let guestIndexByToken = {};

// Jeton de reconnexion propre à ce navigateur, généré une fois puis conservé dans
// localStorage — survit à un rechargement ET à la fermeture/réouverture de l'onglet
// (contrairement à sessionStorage, qui est isolé par onglet et aurait généré un nouveau
// jeton à chaque réouverture, empêchant toute reconnexion réelle). Revers : deux onglets
// ouverts sur la même partie, dans le même navigateur, partageront le même jeton — sans
// conséquence pour un usage normal (un onglet par joueur), seulement pour un test solo
// avec plusieurs onglets qui simuleraient plusieurs joueurs différents.
function getReconnectToken() {
    try {
        let t = localStorage.getItem('bridgeBidReconnectToken');
        if (!t) {
            t = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem('bridgeBidReconnectToken', t);
        }
        return t;
    } catch (e) {
        // localStorage indisponible (navigation privée stricte, etc.) : le jeton ne
        // survivra pas à un rechargement, mais au moins l'app ne plante pas.
        if (!window._fallbackReconnectToken) {
            window._fallbackReconnectToken = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
        return window._fallbackReconnectToken;
    }
}

let mySeats = null;         // sièges contrôlés par ce joueur pendant la partie
let autoPassSeats = [];     // sièges non assignés (robot "passe") — décidé par l'hôte au lancement
let deals = null;           // tableau de donnes parsées
let boardIndex = 0;
let auctionHistory = [];    // historique de la donne en cours : [{seat, call}, ...]

// --- Demande d'annulation (undo) ---
let undoRequestPending = false; // je suis le demandeur, en attente d'une réponse
let pendingUndoAsk = null;      // on me demande d'accepter/refuser une annulation
let hostPendingUndo = null;     // (hôte uniquement) demande en cours d'arbitrage
let undoRequestTimeoutId = null;

function currentDeal() {
    return deals[boardIndex];
}

// Un simple spectateur (non assigné à un siège) ne peut pas naviguer entre les donnes ;
// tout joueur actif (hôte ou invité) le peut.
function canControlBoard() {
    return myRole === 'host' || (mySeats && mySeats.length > 0);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

function defaultParticipantName(pid) {
    if (pid === 'host') return 'Hôte';
    // Nom par défaut d'un nouvel invité, basé sur son rang d'arrivée (pas sur son id, qui
    // est maintenant un jeton opaque et non plus un simple numéro de connexion).
    const guestCount = participants.filter(p => p.id !== 'host').length;
    return 'Guest #' + (guestCount + 1);
}

// ===== Navigation entre écrans =====

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.style.display = 'none');
    document.getElementById(id).style.display = 'block';
}

function setConnectionStatus(connected) {
    const bar = document.getElementById('connectionBar');
    const status = document.getElementById('connectionStatus');
    bar.style.display = 'flex';
    status.textContent = connected ? '🟢 Connecté' : '🔴 Déconnecté';
    status.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
}

function showLandingError(msg) {
    const el = document.getElementById('landingError');
    el.textContent = msg;
    el.style.display = 'block';
}

// ===== Panneau de diagnostic (visible à l'écran, utile sur mobile sans accès aux DevTools) =====

const debugLogLines = [];

function pushDebugLog(line) {
    const timestamp = new Date().toLocaleTimeString('fr-FR');
    debugLogLines.push(`[${timestamp}] ${line}`);
    const content = document.getElementById('debugLogContent');
    if (content) {
        content.textContent = debugLogLines.join('\n');
        content.scrollTop = content.scrollHeight;
    }
}

function uiToggleDebugPanel() {
    const panel = document.getElementById('debugPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function uiCopyDebugLog() {
    const text = debugLogLines.join('\n');
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopyDebugLog(text));
    } else {
        fallbackCopyDebugLog(text);
    }
}

function fallbackCopyDebugLog(text) {
    const content = document.getElementById('debugLogContent');
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
}

// ===== Écran d'accueil : créer / rejoindre =====

function tokenForGuestIndex(guestIndex) {
    return Object.keys(guestIndexByToken).find(t => guestIndexByToken[t] === guestIndex) || null;
}

function uiCreateRoom() {
    document.getElementById('landingError').style.display = 'none';
    if (peerConn) peerConn.destroy();

    myRole = 'host';
    myParticipantId = 'host';
    participants = [{ id: 'host', name: 'Hôte' }];
    seatAssignment = { N: null, E: null, S: null, W: null };
    guestIndexByToken = {};

    peerConn = new BridgePeerConnection({
        onOpen: (role, roomCode) => {
            document.getElementById('roomCodeDisplay').textContent = roomCode;
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode);
            document.getElementById('shareLinkInput').value = url.toString();
            document.getElementById('roomCodeBadge').textContent = 'Code : ' + roomCode;
            document.getElementById('roomCodeBadge').style.display = 'inline';
            enterLobbyScreen();
        },
        onGuestConnected: (guestIndex, metadata) => {
            setConnectionStatus(true);
            // Jeton fourni par l'invité (persistant côté lui, via localStorage) : s'il est
            // déjà connu, c'est un retour (reconnexion), pas un nouvel arrivant. Repli sur un
            // id à l'ancienne pour un client qui n'enverrait pas de jeton (compat).
            const token = (metadata && metadata.reconnectToken) || ('guest' + guestIndex);
            guestIndexByToken[token] = guestIndex;

            let p = participants.find(x => x.id === token);
            const isReturning = !!p;
            if (!p) {
                p = { id: token, name: defaultParticipantName(token), disconnected: false };
                participants.push(p);
            } else {
                p.disconnected = false;
            }
            pushDebugLog(`Connexion #${guestIndex} : jeton ${token.slice(0, 10)}… → ${isReturning ? 'reconnexion reconnue (' + p.name + ')' : 'nouveau participant'}`);

            peerConn.send({ type: 'welcome', yourId: token }, guestIndex);

            if (deals) {
                // La partie est déjà lancée : on renvoie l'état complet (donnes, enchère en
                // cours, sièges) à ce joueur, qu'il soit nouveau ou de retour après coupure.
                // Les sièges "robot" restent ceux décidés au lancement (voir uiStartGameAsHost) :
                // un joueur déconnecté n'est PAS remplacé automatiquement, son siège attend
                // simplement qu'il revienne (voir le tour-indicateur pendant la partie).
                const seatsForThisGuest = SEATS.filter(seat => seatAssignment[seat] === token);
                peerConn.send({
                    type: 'resync',
                    deals, boardIndex, auctionHistory,
                    yourSeats: seatsForThisGuest,
                    botSeats: autoPassSeats
                }, guestIndex);
            }

            broadcastLobbyState();
            renderLobby();
            if (deals) renderBoard();
        },
        onPeerDisconnected: (guestIndex) => {
            setConnectionStatus(peerConn ? peerConn.isConnected() : false);
            const token = tokenForGuestIndex(guestIndex);
            if (token) {
                delete guestIndexByToken[token];
                // On NE supprime pas le participant ni son siège : ils restent réservés, en
                // attente qu'il se reconnecte. Son siège n'est PAS remplacé par un robot —
                // l'enchère patiente simplement (le tour-indicateur le signale clairement).
                const p = participants.find(x => x.id === token);
                if (p) p.disconnected = true;
            }
            hostPendingUndo = null; // un invité qui part au milieu d'un arbitrage : on ne reste pas bloqué
            broadcastLobbyState();
            renderLobby();
            if (deals) renderBoard();
        },
        onSlowConnection: () => {},
        onTimeout: () => {},
        onData: handlePeerData,
        onError: (err) => {
            showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
        }
    });
    peerConn.createRoom();
}

// Construit les handlers PeerJS côté invité — partagés entre uiJoinRoom (première
// connexion) et uiReconnect (après une coupure), pour ne pas dupliquer la logique.
function buildGuestHandlers() {
    return {
        onOpen: (role, roomCode) => {
            document.getElementById('roomCodeBadge').textContent = 'Code : ' + roomCode;
            document.getElementById('roomCodeBadge').style.display = 'inline';
        },
        onGuestConnected: () => {
            everConnectedAsGuest = true;
            setConnectionStatus(true);
            renderReconnectButton();
        },
        onPeerDisconnected: () => {
            setConnectionStatus(false);
            renderReconnectButton();
        },
        onSlowConnection: () => {
            showLandingError("⏳ Ça prend plus de temps que d'habitude... Vérifie que le code est correct.");
        },
        onTimeout: () => {
            if (deals) {
                // On était déjà en jeu : pas de retour à l'écran d'accueil, on laisse le
                // bouton "Se reconnecter" de la barre de connexion (renderReconnectButton).
                return;
            }
            showScreen('screen-landing');
            showLandingError(
                "⚠️ La connexion n'a pas abouti après 45 secondes. Vérifie le code, que l'hôte est " +
                "toujours connecté, et ouvre la console (F12) pour plus de détails avant de réessayer."
            );
        },
        onData: handlePeerData,
        onError: (err) => {
            if (!deals) showScreen('screen-landing');
            if (err && err.type === 'peer-unavailable') {
                showLandingError("Aucune partie trouvée avec ce code. Vérifiez le code ou demandez à l'hôte de le repartager.");
            } else {
                showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
            }
        }
    };
}

function uiJoinRoom() {
    document.getElementById('landingError').style.display = 'none';
    if (peerConn) peerConn.destroy();
    const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
    if (code.length !== 4) {
        showLandingError('Entrez un code à 4 lettres.');
        return;
    }

    myRole = 'guest';
    myParticipantId = null; // fixé à réception du message 'welcome'
    participants = [];
    seatAssignment = { N: null, E: null, S: null, W: null };
    currentRoomCode = code;
    everConnectedAsGuest = false;

    peerConn = new BridgePeerConnection(buildGuestHandlers());
    const token = getReconnectToken();
    pushDebugLog(`Connexion au salon ${code} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(code, { reconnectToken: token });
}

// Reconnexion après coupure : même code de salon, même jeton (localStorage) — l'hôte
// reconnaît le jeton et renvoie automatiquement les sièges et l'état de partie en cours.
function uiReconnect() {
    if (myRole !== 'guest' || !currentRoomCode) return;
    if (peerConn) peerConn.destroy();
    setConnectionStatus(false);
    peerConn = new BridgePeerConnection(buildGuestHandlers());
    const token = getReconnectToken();
    pushDebugLog(`Reconnexion au salon ${currentRoomCode} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(currentRoomCode, { reconnectToken: token });
}

let everConnectedAsGuest = false;

function renderReconnectButton() {
    const btn = document.getElementById('reconnectBtn');
    if (!btn) return;
    const shouldShow = myRole === 'guest' && everConnectedAsGuest && peerConn && !peerConn.isConnected();
    btn.style.display = shouldShow ? '' : 'none';
}

function uiCopyShareLink() {
    const input = document.getElementById('shareLinkInput');
    input.select();
    input.setSelectionRange(0, 99999);
    if (navigator.clipboard) {
        navigator.clipboard.writeText(input.value).catch(() => {});
    }
}

// ===== Salon d'attente =====

function enterLobbyScreen() {
    showScreen('screen-lobby');
    document.getElementById('lobbyRoomCodeBlock').style.display = myRole === 'host' ? 'block' : 'none';
    document.getElementById('hostSetupPanel').style.display = myRole === 'host' ? 'block' : 'none';
    document.getElementById('guestWaitingNote').style.display = myRole === 'host' ? 'none' : 'block';

    const nameInput = document.getElementById('myNameInput');
    if (!nameInput.value) {
        const me = participants.find(p => p.id === myParticipantId);
        nameInput.value = me ? me.name : '';
    }

    renderLobby();
}

function renderLobby() {
    renderParticipantsList();
    renderSeatAssignmentGrid();
}

function renderParticipantsList() {
    const list = document.getElementById('participantsList');
    list.innerHTML = participants.map(p => `
        <li class="participant-item ${p.id === myParticipantId ? 'is-me' : ''}">
            ${escapeHtml(p.name)}
            ${p.id === 'host' ? ' <span class="host-tag">(hôte)</span>' : ''}
            ${p.id === myParticipantId ? ' <span class="me-tag">(vous)</span>' : ''}
            ${p.disconnected ? ' <span class="disconnected-tag">🔌 déconnecté — place réservée</span>' : ''}
        </li>
    `).join('');
}

function renderSeatAssignmentGrid() {
    const container = document.getElementById('seatAssignmentGrid');
    const isHost = myRole === 'host';

    container.innerHTML = SEATS.map(seat => {
        const assignedId = seatAssignment[seat];
        if (isHost) {
            const options = ['<option value="">— (robot : passe)</option>']
                .concat(participants.map(p =>
                    `<option value="${p.id}" ${p.id === assignedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
                ));
            return `
                <div class="seat-box">
                    <span class="seat-box-label">${SEAT_FULL_NAME[seat]}</span>
                    <select class="seat-assign-select" onchange="uiAssignSeat('${seat}', this.value)">${options.join('')}</select>
                </div>
            `;
        }
        const p = participants.find(x => x.id === assignedId);
        const name = p ? escapeHtml(p.name) : '— (robot)';
        return `
            <div class="seat-box">
                <span class="seat-box-label">${SEAT_FULL_NAME[seat]}</span>
                <span class="seat-box-name">${name}</span>
            </div>
        `;
    }).join('');
}

let nameUpdateDebounceTimer = null;
function uiUpdateMyName() {
    clearTimeout(nameUpdateDebounceTimer);
    nameUpdateDebounceTimer = setTimeout(() => {
        const input = document.getElementById('myNameInput');
        const name = input.value.trim() || defaultParticipantName(myParticipantId);
        const me = participants.find(p => p.id === myParticipantId);
        if (me) me.name = name;

        if (myRole === 'host') {
            broadcastLobbyState();
            renderLobby();
        } else if (peerConn) {
            peerConn.send({ type: 'set-name', name });
            renderLobby();
        }
    }, 300);
}

function uiAssignSeat(seat, participantId) {
    if (myRole !== 'host') return;
    seatAssignment[seat] = participantId || null;
    broadcastLobbyState();
    renderLobby();
}

function broadcastLobbyState() {
    peerConn.send({ type: 'lobby-state', participants, seatAssignment });
}

// ===== Démarrage de la partie (hôte) =====

function uiStartGameAsHost() {
    const fileInput = document.getElementById('dealFileInput');
    const errorEl = document.getElementById('hostSetupError');
    errorEl.style.display = 'none';

    if (!fileInput.files || fileInput.files.length === 0) {
        errorEl.textContent = 'Choisissez un fichier .pbn ou .lin.';
        errorEl.style.display = 'block';
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = () => {
        let parsedDeals;
        try {
            parsedDeals = parseDealFile(reader.result, file.name);
        } catch (err) {
            errorEl.textContent = '⚠️ ' + err.message;
            errorEl.style.display = 'block';
            return;
        }

        deals = parsedDeals;
        boardIndex = 0;
        auctionHistory = [];
        hostPendingUndo = null;
        clearUndoUiState();

        const botSeats = SEATS.filter(seat => !seatAssignment[seat]);
        mySeats = SEATS.filter(seat => seatAssignment[seat] === 'host');
        autoPassSeats = botSeats;

        participants.filter(p => p.id !== 'host' && !p.disconnected).forEach(p => {
            const guestIndex = guestIndexForParticipant(p.id);
            if (guestIndex == null) return;
            const seatsForThisGuest = SEATS.filter(seat => seatAssignment[seat] === p.id);
            peerConn.send({ type: 'start-game', deals, yourSeats: seatsForThisGuest, botSeats }, guestIndex);
        });

        enterGameScreen();
    };

    reader.onerror = () => {
        errorEl.textContent = 'Impossible de lire ce fichier.';
        errorEl.style.display = 'block';
    };

    reader.readAsText(file);
}

// ===== Réception des messages des autres joueurs =====

function handlePeerData(msg, guestIndex) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'welcome': {
            myParticipantId = msg.yourId;
            break;
        }

        case 'set-name': {
            if (myRole !== 'host') return;
            const pid = tokenForGuestIndex(guestIndex);
            const p = participants.find(x => x.id === pid);
            if (p) p.name = msg.name || p.name;
            broadcastLobbyState();
            renderLobby();
            break;
        }

        case 'lobby-state': {
            participants = msg.participants;
            seatAssignment = msg.seatAssignment;
            // Ce message est aussi renvoyé quand la connectivité change en pleine partie
            // (quelqu'un se (re)connecte) : on ne bascule à l'écran du salon que si la
            // partie n'a pas encore commencé, sinon ça arracherait un invité de sa table.
            if (myRole === 'guest' && !deals) enterLobbyScreen();
            break;
        }

        case 'start-game': {
            deals = msg.deals;
            mySeats = msg.yourSeats;
            autoPassSeats = msg.botSeats || [];
            boardIndex = 0;
            auctionHistory = [];
            hostPendingUndo = null;
            clearUndoUiState();
            enterGameScreen();
            break;
        }

        // Reçu après une (re)connexion alors que la partie est déjà en cours : remet ce
        // joueur exactement là où en est la table (donne, enchère, sièges), qu'il soit
        // nouveau ou de retour après une coupure.
        case 'resync': {
            deals = msg.deals;
            mySeats = msg.yourSeats;
            autoPassSeats = msg.botSeats || [];
            boardIndex = msg.boardIndex;
            auctionHistory = msg.auctionHistory || [];
            hostPendingUndo = null;
            clearUndoUiState();
            enterGameScreen();
            break;
        }

        case 'call': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            const deal = currentDeal();
            const expectedSeat = currentTurnSeat(deal.dealer, auctionHistory);
            if (msg.seat !== expectedSeat || !isCallLegal(auctionHistory, msg.call, msg.seat)) {
                console.warn('Annonce reçue invalide, ignorée :', msg);
                return;
            }
            applyCall(msg.seat, msg.call);
            relayIfHost(msg, guestIndex);
            break;
        }

        case 'reset-auction': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            auctionHistory = [];
            hostPendingUndo = null;
            clearUndoUiState();
            renderAuctionLedger();
            renderBiddingBox();
            renderMyHands();
            checkAuctionEnd();
            relayIfHost(msg, guestIndex);
            break;
        }

        case 'goto-board': {
            if (!deals) return;
            boardIndex = msg.boardIndex;
            auctionHistory = [];
            hostPendingUndo = null;
            clearUndoUiState();
            renderBoard();
            relayIfHost(msg, guestIndex);
            break;
        }

        // --- Demande d'annulation (undo) ---
        // Voir la section "Demande d'annulation (undo)" plus bas pour le détail du protocole.
        // L'hôte est toujours l'arbitre : 'undo-request' et 'undo-answer' ne sont traités
        // que par lui ; 'undo-ask', 'undo-apply' et 'undo-rejected' sont ce qu'il diffuse.
        case 'undo-request': {
            if (myRole !== 'host') return;
            hostHandleUndoRequest(msg);
            break;
        }

        case 'undo-ask': {
            pendingUndoAsk = msg;
            renderUndoAskBanner();
            renderUndoControls();
            break;
        }

        case 'undo-answer': {
            if (myRole !== 'host') return;
            hostReceiveUndoAnswer(msg);
            break;
        }

        case 'undo-apply': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            if (auctionHistory.length > 0) auctionHistory.pop();
            renderAuctionLedger();
            renderBiddingBox();
            renderMyHands();
            checkAuctionEnd();
            clearUndoUiState();
            break;
        }

        case 'undo-rejected': {
            if (msg.requesterId !== myParticipantId) return;
            clearUndoUiState();
            setUndoStatus(undoRejectReasonText(msg.reason));
            break;
        }
    }
}

// Quand l'hôte reçoit un message d'un invité, il le relaie aux AUTRES invités (les invités
// ne sont jamais connectés entre eux). Ne fait rien de plus en configuration à 2 joueurs.
function relayIfHost(msg, fromGuestIndex) {
    if (myRole === 'host') {
        peerConn.sendExcept(msg, fromGuestIndex);
    }
}

// ===== Robot "passe automatique" (sièges non assignés) =====
//
// Seul l'hôte injecte les passes automatiques (pour ne jamais les déclencher en double),
// puis les diffuse comme n'importe quelle annonce.
function maybeAutoPass() {
    if (myRole !== 'host') return;
    if (!autoPassSeats || autoPassSeats.length === 0) return;
    if (!deals || isAuctionOver(auctionHistory)) return;

    const deal = currentDeal();
    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    if (!autoPassSeats.includes(turnSeat)) return;

    const boardAtSchedule = boardIndex;
    const historyLengthAtSchedule = auctionHistory.length;

    setTimeout(() => {
        if (boardIndex !== boardAtSchedule) return;
        if (auctionHistory.length !== historyLengthAtSchedule) return;
        if (isAuctionOver(auctionHistory)) return;
        const stillTurnSeat = currentTurnSeat(currentDeal().dealer, auctionHistory);
        if (stillTurnSeat !== turnSeat) return;

        applyCall(turnSeat, 'PASS');
        peerConn.send({ type: 'call', boardIndex, seat: turnSeat, call: 'PASS' });
    }, 700);
}

// ===== Écran de jeu =====

function enterGameScreen() {
    showScreen('screen-game');
    renderBoard();
}

function seatFullName(seat) {
    return SEAT_FULL_NAME[seat];
}

function renderBoard() {
    renderGameHeader();
    renderMyHands();
    renderAuctionLedger();
    renderBiddingBox();
    checkAuctionEnd();
    updateBoardControlVisibility();
    renderUndoControls();
    renderUndoAskBanner();
    renderBoardSkipControls();
    maybeAutoPass();
}

function updateBoardControlVisibility() {
    const resetBtn = document.getElementById('resetAuctionBtn');
    if (resetBtn) resetBtn.style.display = canControlBoard() ? '' : 'none';
}

function renderGameHeader() {
    const deal = currentDeal();
    document.getElementById('boardNumberLabel').textContent = `Donne #${deal.board} (${boardIndex + 1}/${deals.length})`;
    const mySeatsLabel = mySeats && mySeats.length > 0 ? mySeats.map(seatFullName).join(' + ') : 'spectateur';
    document.getElementById('dealerVulnLabel').textContent =
        `Donneur : ${seatFullName(deal.dealer)} · ${VULN_LABEL[deal.vulnerable]} · Vous jouez : ${mySeatsLabel}`;
}

function renderMyHands() {
    const deal = currentDeal();
    const container = document.getElementById('myHandsContainer');

    if (!mySeats || mySeats.length === 0) {
        container.innerHTML = '<div class="info-text">Vous êtes spectateur sur cette table.</div>';
        return;
    }

    // Distinction main active / inactive : seulement utile quand on contrôle plusieurs
    // sièges, et seulement pendant l'enchère (une fois terminée, plus de "tour" à signaler).
    const showActiveState = mySeats.length > 1 && !isAuctionOver(auctionHistory);
    const turnSeat = showActiveState ? currentTurnSeat(deal.dealer, auctionHistory) : null;

    container.innerHTML = mySeats.map(seat => {
        const hand = deal.hands[seat];
        const lines = ['S', 'H', 'D', 'C'].map(suit => `
            <div class="card-line">
                <span class="suit-symbol ${SUIT_CLASSES[suit]}">${SUIT_SYMBOLS[suit]}</span>
                <span class="cards">${hand[suit] || '—'}</span>
            </div>
        `).join('');

        const stateClass = showActiveState ? (seat === turnSeat ? 'hand-card-active' : 'hand-card-inactive') : '';

        return `
            <div class="hand-card ${stateClass}">
                <div class="hand-card-title">${seatFullName(seat)}</div>
                <div class="hand-cards">${lines}</div>
            </div>
        `;
    }).join('');
}

// Rendu coloré d'une annonce en dehors de la boîte d'enchères (relevé, contrat final) :
// même logique de classe de couleur que les boutons (SUIT_CLASSES), sur du texte simple.
function formatCallCellHtml(call) {
    const text = formatCallForDisplay(call);
    const b = parseBid(call);
    if (!b) return escapeHtml(text); // Passe / X / XX : pas de couleur de suite
    const cls = SUIT_CLASSES[b.strain] || 'notrump';
    return `<span class="call-suit ${cls}">${escapeHtml(text)}</span>`;
}

function renderAuctionLedger() {
    const deal = currentDeal();
    const header = document.getElementById('auctionLedgerHeader');
    const turnSeat = isAuctionOver(auctionHistory) ? null : currentTurnSeat(deal.dealer, auctionHistory);
    header.innerHTML = SEATS.map(s => {
        const pair = partnershipOf(s);
        const isVulnerable = deal.vulnerable === 'Both' || deal.vulnerable === pair;
        const vulnClass = isVulnerable ? 'vuln-bar-danger' : 'vuln-bar-safe';
        const classes = [s === turnSeat ? 'turn-col' : ''].filter(Boolean).join(' ');
        return `<th class="${classes}">
            <span class="ledger-seat-label">${SEAT_ABBR_FR[s]}${s === deal.dealer ? ' (D)' : ''}</span>
            <span class="vuln-bar ${vulnClass}"></span>
        </th>`;
    }).join('');

    const dealerIdx = SEATS.indexOf(deal.dealer);
    const slots = new Array(dealerIdx).fill('');
    auctionHistory.forEach(entry => slots.push(formatCallCellHtml(entry.call)));

    const rows = [];
    for (let i = 0; i < slots.length || rows.length === 0; i += 4) {
        rows.push(slots.slice(i, i + 4));
        if (i + 4 >= slots.length) break;
    }

    const body = document.getElementById('auctionLedgerBody');
    body.innerHTML = rows.map(row => {
        const cells = [0, 1, 2, 3].map(i => `<td>${row[i] != null ? row[i] : ''}</td>`);
        return `<tr>${cells.join('')}</tr>`;
    }).join('');
}

function renderBiddingBox() {
    const box = document.getElementById('biddingBox');
    const turnPanel = document.getElementById('turnIndicator');
    const deal = currentDeal();

    if (isAuctionOver(auctionHistory)) {
        box.innerHTML = '';
        turnPanel.textContent = '';
        return;
    }

    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    const myTurn = mySeats && mySeats.includes(turnSeat);

    const turnOwnerId = seatAssignment[turnSeat];
    const turnOwner = turnOwnerId ? participants.find(p => p.id === turnOwnerId) : null;
    const ownerDisconnected = !!(turnOwner && turnOwner.disconnected);

    if (myTurn) {
        turnPanel.textContent = `À vous d'enchérir (${seatFullName(turnSeat)})`;
    } else if (ownerDisconnected) {
        turnPanel.textContent = `🔌 En attente que ${turnOwner.name} se reconnecte (${seatFullName(turnSeat)})...`;
    } else {
        turnPanel.textContent = `En attente de ${seatFullName(turnSeat)}...`;
    }
    turnPanel.className = 'turn-indicator ' + (myTurn ? 'my-turn' : (ownerDisconnected ? 'disconnected-turn' : 'their-turn'));

    const specialLabels = { PASS: 'Passe', X: 'X', XX: 'XX' };
    const specialRow = ['PASS', 'X', 'XX'].map(call => {
        const legal = myTurn && isCallLegal(auctionHistory, call, turnSeat);
        return `<button class="call-btn call-btn-special" ${legal ? '' : 'disabled'} onclick="uiMakeCall('${call}')">${specialLabels[call]}</button>`;
    }).join('');

    const bidRows = [];
    for (let level = 1; level <= 7; level++) {
        const cells = STRAINS.map(strain => {
            const call = `${level}${strain}`;
            const legal = myTurn && isCallLegal(auctionHistory, call, turnSeat);
            const label = strain === 'NT' ? 'SA' : SUIT_SYMBOLS[strain];
            const suitClass = SUIT_CLASSES[strain] || 'notrump';
            return `<button class="call-btn ${suitClass}" ${legal ? '' : 'disabled'} onclick="uiMakeCall('${call}')">${level}${label}</button>`;
        }).join('');
        bidRows.push(`<div class="bid-row">${cells}</div>`);
    }

    box.innerHTML = `
        <div class="special-calls-row">${specialRow}</div>
        <div class="bid-grid">${bidRows.join('')}</div>
    `;
}

function uiMakeCall(call) {
    const deal = currentDeal();
    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    if (!mySeats || !mySeats.includes(turnSeat)) return;
    if (!isCallLegal(auctionHistory, call, turnSeat)) return;

    applyCall(turnSeat, call);
    peerConn.send({ type: 'call', boardIndex, seat: turnSeat, call });
}

function applyCall(seat, call) {
    auctionHistory.push({ seat, call });
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    renderUndoControls();
    maybeAutoPass();
}

function renderAllHandsDiagram() {
    const container = document.getElementById('allHandsDiagram');
    const deal = currentDeal();

    container.innerHTML = SEATS.map(seat => {
        const hand = deal.hands[seat];
        const lines = ['S', 'H', 'D', 'C'].map(suit => `
            <div class="card-line">
                <span class="suit-symbol ${SUIT_CLASSES[suit]}">${SUIT_SYMBOLS[suit]}</span>
                <span class="cards">${hand[suit] || '—'}</span>
            </div>
        `).join('');

        return `
            <div class="hand-card hand-${seat}">
                <div class="hand-card-title">${seatFullName(seat)}</div>
                <div class="hand-cards">${lines}</div>
            </div>
        `;
    }).join('');
}

const STRAIN_ORDER = ['N', 'S', 'H', 'D', 'C']; // N = sans-atout (SA), pas Nord
const STRAIN_DISPLAY = {
    N: { label: 'SA', class: 'notrump' },
    S: { label: '♠', class: 'spades' },
    H: { label: '♥', class: 'hearts' },
    D: { label: '♦', class: 'diamonds' },
    C: { label: '♣', class: 'clubs' }
};

// Convertit un nombre de levées (sur 13) en palier de contrat réalisable : il faut
// 6 levées de base + le palier, donc palier = levées - 6. En dessous de 7 levées, aucun
// contrat n'est réalisable (le palier serait nul ou négatif) : on affiche "―".
function tricksToContractLevel(tricks) {
    if (tricks == null) return '—';
    const level = tricks - 6;
    return level >= 1 ? String(level) : '―';
}

// Ordre d'affichage des colonnes de la table du double mort : N S E O (les deux camps
// groupés côte à côte), plus pratique à lire que l'ordre de rotation des enchères N E S O
// utilisé partout ailleurs (SEATS, dans bidding-rules.js) — surtout ne pas réutiliser
// SEATS ici, sous peine de casser la logique de tour de parole.
const DD_TABLE_SEAT_ORDER = ['N', 'S', 'E', 'W'];

// Construit le tableau HTML du double mort (5 lignes SA/♠/♥/♦/♣ x 4 colonnes N/S/E/O),
// tel qu'éventuellement fourni dans le fichier PBN chargé (tag [OptimumResultTable]).
// Affiche le palier de contrat réalisable (et non le nombre brut de levées).
function renderDDTable(ddTable) {
    if (!ddTable) return '';
    const rows = STRAIN_ORDER.map(strain => {
        const info = STRAIN_DISPLAY[strain];
        const cells = DD_TABLE_SEAT_ORDER.map(pos => `<td>${tricksToContractLevel(ddTable[strain][pos])}</td>`).join('');
        return `<tr><th class="${info.class}">${info.label}</th>${cells}</tr>`;
    }).join('');
    return `
        <div class="dd-table-title">Table du double mort (fournie dans le fichier)</div>
        <table class="dd-table">
            <thead><tr><th></th>${DD_TABLE_SEAT_ORDER.map(p => `<th>${SEAT_ABBR_FR[p]}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function checkAuctionEnd() {
    const resultEl = document.getElementById('contractResult');
    const nextPanel = document.getElementById('nextBoardPanel');
    const diagramEl = document.getElementById('allHandsDiagram');

    if (!isAuctionOver(auctionHistory)) {
        resultEl.style.display = 'none';
        nextPanel.style.display = 'none';
        diagramEl.style.display = 'none';
        return;
    }

    const contract = determineContract(auctionHistory);
    resultEl.style.display = 'block';
    if (!contract) {
        resultEl.innerHTML = "↩️ Donne passée — personne n'a annoncé.";
    } else {
        const strainCls = SUIT_CLASSES[contract.strain] || 'notrump';
        const contractHtml = `<span class="call-suit ${strainCls}">${escapeHtml(contract.contractString)}</span>`;
        resultEl.innerHTML = `Contrat final : <strong>${contractHtml}</strong> par <strong>${seatFullName(contract.declarer)}</strong>`;
    }

    const ddTableHtml = renderDDTable(currentDeal().ddTable);
    if (ddTableHtml) {
        resultEl.innerHTML += ddTableHtml;
    }

    renderAllHandsDiagram();
    diagramEl.style.display = 'grid';

    const isLastBoard = boardIndex >= deals.length - 1;
    const iCanNavigate = canControlBoard();
    nextPanel.style.display = (isLastBoard || !iCanNavigate) ? 'none' : 'block';

    if (isLastBoard) {
        resultEl.innerHTML += '<div class="info-text">Dernière donne du fichier chargé.</div>';
    } else if (!iCanNavigate) {
        resultEl.innerHTML += '<div class="info-text">En attente qu\'un joueur actif passe à la donne suivante.</div>';
    }
}

// ===== Demande d'annulation (undo) =====
//
// Un joueur actif peut demander l'annulation de la dernière annonce (utile en cas de
// mauvais clic). Cette annonce a pu déjà donner une information au camp adverse : on ne
// l'annule donc jamais tout seul dans son coin, il faut l'accord d'un adversaire humain.
// S'il n'y a personne à convaincre en face (siège robot, ou la même personne joue les
// deux camps), l'annulation s'applique immédiatement.
//
// Protocole (voir aussi peer-connection.js) :
//   'undo-request' (→ hôte)      le demandeur sollicite une annulation
//   'undo-ask'     (hôte →)      l'hôte demande l'accord à un adversaire humain
//   'undo-answer'  (→ hôte)      la réponse de cet adversaire (accepté/refusé)
//   'undo-apply'   (hôte →)      l'annulation est actée, tout le monde retire la dernière annonce
//   'undo-rejected'(hôte →)      informe le demandeur que ça ne s'est pas fait, et pourquoi
//
// L'hôte est toujours l'arbitre (hostPendingUndo) : c'est le seul point de passage
// obligé entre deux invités (topologie en étoile). Quand l'hôte est lui-même demandeur ou
// répondeur, ces messages sont traités directement en local (voir deliverToParticipant),
// sans aller-retour réseau inutile.

function clearUndoUiState() {
    undoRequestPending = false;
    pendingUndoAsk = null;
    clearTimeout(undoRequestTimeoutId);
    undoRequestTimeoutId = null;
    renderUndoControls();
    renderUndoAskBanner();
}

function setUndoStatus(text) {
    const el = document.getElementById('undoStatusText');
    if (el) el.textContent = text || '';
}

function renderUndoControls() {
    const btn = document.getElementById('requestUndoBtn');
    if (!btn) return;
    const visible = canControlBoard();
    btn.style.display = visible ? '' : 'none';
    btn.disabled = !visible || !deals || auctionHistory.length === 0 || undoRequestPending || !!pendingUndoAsk;
    btn.textContent = undoRequestPending ? '⏳ Demande envoyée...' : "↩️ Demander un undo";
}

function renderUndoAskBanner() {
    const banner = document.getElementById('undoAskBanner');
    if (!banner) return;
    if (!pendingUndoAsk) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    const name = escapeHtml(participantName(pendingUndoAsk.requesterId));
    banner.style.display = 'flex';
    banner.innerHTML = `
        <span>${name} demande à annuler la dernière annonce.</span>
        <button class="btn btn-success btn-small" onclick="uiAnswerUndo(true)">Accepter</button>
        <button class="btn btn-secondary btn-small" onclick="uiAnswerUndo(false)">Refuser</button>
    `;
}

function participantName(pid) {
    if (pid === 'host') return "L'hôte";
    const p = participants.find(x => x.id === pid);
    return p ? p.name : 'Un joueur';
}

function partnershipSeats(partnership) {
    return SEATS.filter(s => partnershipOf(s) === partnership);
}

function guestIndexForParticipant(pid) {
    if (!pid || pid === 'host') return null;
    return Object.prototype.hasOwnProperty.call(guestIndexByToken, pid) ? guestIndexByToken[pid] : null;
}

// Participants humains "en face" du camp qui a fait la dernière annonce, hors le
// demandeur — ce sont eux dont l'accord est requis pour annuler.
function humanOpponentsFor(requesterId) {
    if (auctionHistory.length === 0) return [];
    const lastSeat = auctionHistory[auctionHistory.length - 1].seat;
    const opposing = partnershipOf(lastSeat) === 'NS' ? partnershipSeats('EW') : partnershipSeats('NS');
    const ids = new Set();
    opposing.forEach(seat => {
        const pid = seatAssignment[seat];
        if (pid && pid !== requesterId) ids.add(pid);
    });
    return Array.from(ids);
}

function undoRejectReasonText(reason) {
    switch (reason) {
        case 'declined': return 'Annulation refusée.';
        case 'timeout': return "Personne n'a répondu à temps.";
        case 'busy': return 'Une autre demande est déjà en cours, réessayez.';
        case 'stale': return 'La situation a changé entre-temps, réessayez.';
        default: return "Impossible d'annuler pour le moment.";
    }
}

// Envoie `msg` à un participant donné — sans passer par le réseau si ce participant,
// c'est nous (l'hôte est toujours au centre de l'arbitrage, y compris pour lui-même).
function deliverToParticipant(pid, msg) {
    if (pid === myParticipantId) {
        if (msg.type === 'undo-ask') {
            pendingUndoAsk = msg;
            renderUndoAskBanner();
            renderUndoControls();
        } else if (msg.type === 'undo-rejected') {
            clearUndoUiState();
            setUndoStatus(undoRejectReasonText(msg.reason));
        }
        return;
    }
    const gi = guestIndexForParticipant(pid);
    if (gi != null) peerConn.send(msg, gi);
}

function uiRequestUndo() {
    if (!canControlBoard() || !deals || auctionHistory.length === 0) return;
    if (undoRequestPending || pendingUndoAsk) return;

    const msg = {
        type: 'undo-request',
        boardIndex,
        requesterId: myParticipantId,
        historyLengthAtRequest: auctionHistory.length
    };

    undoRequestPending = true;
    setUndoStatus('');
    renderUndoControls();

    clearTimeout(undoRequestTimeoutId);
    undoRequestTimeoutId = setTimeout(() => {
        if (undoRequestPending) {
            undoRequestPending = false;
            renderUndoControls();
            setUndoStatus("Personne n'a répondu à temps.");
        }
    }, 20000);

    if (myRole === 'host') {
        hostHandleUndoRequest(msg);
    } else {
        peerConn.send(msg);
    }
}

// (Hôte) Reçoit une demande d'annulation — la sienne, ou celle d'un invité relayée par
// handlePeerData — et décide si elle nécessite l'accord d'un adversaire humain.
function hostHandleUndoRequest(msg) {
    if (hostPendingUndo) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'busy' });
        return;
    }
    if (msg.boardIndex !== boardIndex || msg.historyLengthAtRequest !== auctionHistory.length) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'stale' });
        return;
    }

    const opponents = humanOpponentsFor(msg.requesterId);
    if (opponents.length === 0) {
        applyUndoAsHost({ boardIndex: msg.boardIndex, requesterId: msg.requesterId, historyLengthAtRequest: msg.historyLengthAtRequest });
        return;
    }

    hostPendingUndo = { requesterId: msg.requesterId, boardIndex: msg.boardIndex, historyLengthAtRequest: msg.historyLengthAtRequest };

    const askMsg = {
        type: 'undo-ask',
        boardIndex: msg.boardIndex,
        requesterId: msg.requesterId,
        historyLengthAtRequest: msg.historyLengthAtRequest
    };
    opponents.forEach(pid => deliverToParticipant(pid, askMsg));

    setTimeout(() => {
        if (hostPendingUndo &&
            hostPendingUndo.requesterId === msg.requesterId &&
            hostPendingUndo.boardIndex === msg.boardIndex &&
            hostPendingUndo.historyLengthAtRequest === msg.historyLengthAtRequest) {
            hostPendingUndo = null;
            deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'timeout' });
        }
    }, 20000);
}

// (Hôte) Reçoit la réponse (accepté/refusé) d'un adversaire — la sienne, ou celle d'un
// invité relayée par handlePeerData. Seule la première réponse compte.
function hostReceiveUndoAnswer(msg) {
    if (!hostPendingUndo) return;
    if (msg.boardIndex !== hostPendingUndo.boardIndex || msg.historyLengthAtRequest !== hostPendingUndo.historyLengthAtRequest) return;

    const resolved = hostPendingUndo;
    hostPendingUndo = null;

    if (msg.approved) {
        applyUndoAsHost(resolved);
    } else {
        deliverToParticipant(resolved.requesterId, { type: 'undo-rejected', boardIndex: resolved.boardIndex, requesterId: resolved.requesterId, reason: 'declined' });
    }
}

// (Hôte) Applique effectivement l'annulation et la diffuse à tout le monde.
function applyUndoAsHost(pending) {
    if (pending.boardIndex !== boardIndex || pending.historyLengthAtRequest !== auctionHistory.length) {
        deliverToParticipant(pending.requesterId, { type: 'undo-rejected', boardIndex: pending.boardIndex, requesterId: pending.requesterId, reason: 'stale' });
        return;
    }
    auctionHistory.pop();
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    clearUndoUiState();
    peerConn.send({ type: 'undo-apply', boardIndex: pending.boardIndex });
}

// Réponse de l'utilisateur au bandeau "on me demande d'annuler".
function uiAnswerUndo(approved) {
    const ask = pendingUndoAsk;
    if (!ask) return;
    pendingUndoAsk = null;
    renderUndoAskBanner();
    renderUndoControls();

    const answerMsg = {
        type: 'undo-answer',
        boardIndex: ask.boardIndex,
        requesterId: ask.requesterId,
        historyLengthAtRequest: ask.historyLengthAtRequest,
        approved
    };

    if (myRole === 'host') {
        hostReceiveUndoAnswer(answerMsg);
    } else {
        peerConn.send(answerMsg);
    }
}

function uiResetAuction() {
    if (!canControlBoard()) return;
    auctionHistory = [];
    hostPendingUndo = null;
    clearUndoUiState();
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    peerConn.send({ type: 'reset-auction', boardIndex });
}

// Change de donne : remet l'enchère à zéro, annule toute demande d'undo en cours, et
// diffuse le nouvel index à tout le monde. Partagé par le bouton "Donne suivante →"
// (accessible à tout joueur actif, uniquement une fois l'enchère terminée — voir
// checkAuctionEnd) et par les flèches ◀▶ de navigation libre, réservées à l'hôte.
function gotoBoard(newIndex) {
    boardIndex = newIndex;
    auctionHistory = [];
    hostPendingUndo = null;
    clearUndoUiState();
    renderBoard();
    peerConn.send({ type: 'goto-board', boardIndex });
}

function uiNextBoard() {
    if (!canControlBoard()) return;
    if (boardIndex >= deals.length - 1) return;
    gotoBoard(boardIndex + 1);
}

// Navigation libre entre les donnes (avancer ou reculer, y compris en pleine enchère) :
// réservée à l'hôte, pour pouvoir sauter une donne sans attendre que l'enchère en cours
// se termine.
function uiHostSkipNextBoard() {
    if (myRole !== 'host' || !deals) return;
    if (boardIndex >= deals.length - 1) return;
    gotoBoard(boardIndex + 1);
}

function uiHostSkipPrevBoard() {
    if (myRole !== 'host' || !deals) return;
    if (boardIndex <= 0) return;
    gotoBoard(boardIndex - 1);
}

function renderBoardSkipControls() {
    const prevBtn = document.getElementById('prevBoardBtn');
    const nextBtn = document.getElementById('skipNextBoardBtn');
    if (!prevBtn || !nextBtn) return;
    const isHost = myRole === 'host';
    prevBtn.style.display = isHost ? '' : 'none';
    nextBtn.style.display = isHost ? '' : 'none';
    if (!isHost || !deals) return;
    prevBtn.disabled = boardIndex <= 0;
    nextBtn.disabled = boardIndex >= deals.length - 1;
}

// ===== Initialisation =====

window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
        document.getElementById('joinCodeInput').value = room.toUpperCase();
        uiJoinRoom();
    }
});
