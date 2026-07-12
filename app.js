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

// Icônes SVG dessinées à la main (dossier suits/), en remplacement des caractères Unicode
// ♠♥♦♣ dont le rendu varie trop selon la police/plateforme (notamment ♣ et ♠ qui
// deviennent des émojis colorés sur certains systèmes). Couleurs déjà "cuites" dans
// chaque SVG (palette quatre couleurs : pique noir, cœur rouge, carreau orange, trèfle
// bleu) — pas besoin de les recolorer en CSS.
function suitIconHtml(suit, extraClass) {
    return `<img class="suit-icon ${SUIT_CLASSES[suit]}${extraClass ? ' ' + extraClass : ''}" src="suits/${suit}.svg" alt="${SUIT_SYMBOLS[suit]}">`;
}
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

// ===== Préférences d'affichage des mains (locales, persistées, indépendantes du réseau) =====
//
// Purement cosmétique et propre à chaque appareil (comme le jeton de reconnexion) : pas
// besoin de les synchroniser entre joueurs, chacun choisit sa propre présentation.

function loadBoolPref(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === 'true';
    } catch (e) {
        return fallback;
    }
}

function saveBoolPref(key, value) {
    try { localStorage.setItem(key, value ? 'true' : 'false'); } catch (e) { /* navigation privée stricte, tant pis */ }
}

let useFrenchRanks = loadBoolPref('bridgeBidFrenchRanks', false); // R/D/V/X au lieu de K/Q/J/T
let showHcp = loadBoolPref('bridgeBidShowHcp', false);            // affiche le compte de points d'honneur par main

const FRENCH_RANK_LETTER = { K: 'R', Q: 'D', J: 'V', T: 'X' };

// Convertit une chaîne de rangs (ex: "AKQT98") selon la préférence de notation en cours.
function formatRanksForDisplay(ranks) {
    if (!ranks) return '';
    if (!useFrenchRanks) return ranks;
    return ranks.split('').map(c => FRENCH_RANK_LETTER[c] || c).join('');
}

const HCP_VALUE = { A: 4, K: 3, Q: 2, J: 1 };

// Compte de points d'honneur (High Card Points) d'une main : As=4, Roi=3, Dame=2, Valet=1.
function computeHandHcp(hand) {
    let total = 0;
    ['S', 'H', 'D', 'C'].forEach(suit => {
        const ranks = hand[suit] || '';
        for (const c of ranks) total += HCP_VALUE[c] || 0;
    });
    return total;
}

function uiToggleFrenchRanks() {
    useFrenchRanks = !useFrenchRanks;
    saveBoolPref('bridgeBidFrenchRanks', useFrenchRanks);
    renderHandDisplayOptionButtons();
    if (deals) {
        renderMyHands();
        if (isAuctionOver(auctionHistory)) renderAllHandsDiagram();
    }
}

function uiToggleShowHcp() {
    showHcp = !showHcp;
    saveBoolPref('bridgeBidShowHcp', showHcp);
    renderHandDisplayOptionButtons();
    if (deals) {
        renderMyHands();
        if (isAuctionOver(auctionHistory)) renderAllHandsDiagram();
    }
}

function renderHandDisplayOptionButtons() {
    const frBtn = document.getElementById('frenchRanksToggleBtn');
    if (frBtn) frBtn.classList.toggle('is-active', useFrenchRanks);

    const hcpBtn = document.getElementById('hcpToggleBtn');
    if (hcpBtn) hcpBtn.classList.toggle('is-active', showHcp);
}
let deals = null;           // tableau de donnes parsées
let boardIndex = 0;
let auctionHistory = [];    // historique de la donne en cours : [{seat, call}, ...]

// (Hôte) Résultat du fichier de donnes déjà lu et parsé au moment où il a été choisi (voir
// uiHandleDealFileChosen), pour afficher tout de suite une éventuelle erreur ou
// l'avertissement "PARs non disponibles" — pendant que l'hôte compose encore la table,
// PAS au moment de cliquer sur "Commencer la partie", puisqu'à cet instant l'écran du
// salon (et donc le message) disparaît immédiatement avec le passage à l'écran de jeu.
let pendingParsedDeals = null;
let pendingParsedFile = null; // le File dont pendingParsedDeals est le résultat, pour savoir si le cache est encore valable

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
    pendingParsedDeals = null;
    pendingParsedFile = null;

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
    // On ne touche jamais au champ pendant que l'utilisateur est en train d'y taper
    // (sinon un lobby-state reçu pile pendant l'effacement du nom réécrase ce qu'il
    // est en train de saisir).
    if (!nameInput.value && document.activeElement !== nameInput) {
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
    // Si l'hôte est en train de renommer quelqu'un, on ne reconstruit pas la liste
    // (un reflow ici lui ferait perdre le focus et le curseur en pleine frappe).
    if (document.activeElement && document.activeElement.classList.contains('participant-rename-input')) {
        return;
    }
    const isHost = myRole === 'host';
    list.innerHTML = participants.map(p => {
        const canRename = isHost && p.id !== myParticipantId;
        const nameHtml = canRename
            ? `<input type="text" class="participant-rename-input" maxlength="20" value="${escapeHtml(p.name)}"
                   oninput="uiRenameParticipant('${p.id}', this.value)"
                   onblur="uiRenameParticipantBlur('${p.id}', this)">`
            : escapeHtml(p.name);
        return `
        <li class="participant-item ${p.id === myParticipantId ? 'is-me' : ''}">
            ${nameHtml}
            ${p.id === 'host' ? ' <span class="host-tag">(hôte)</span>' : ''}
            ${p.id === myParticipantId ? ' <span class="me-tag">(vous)</span>' : ''}
            ${p.disconnected ? ' <span class="disconnected-tag">🔌 déconnecté — place réservée</span>' : ''}
        </li>
    `;
    }).join('');
}

let participantRenameDebounceTimers = {};
// Renommage d'un participant par l'hôte. On met à jour et on diffuse, mais sans
// reconstruire la liste des participants pendant la frappe (voir garde ci-dessus) —
// la grille des sièges, elle, peut se rafraîchir sans risque puisqu'elle ne contient
// pas le champ en cours d'édition.
function uiRenameParticipant(participantId, value) {
    if (myRole !== 'host') return;
    clearTimeout(participantRenameDebounceTimers[participantId]);
    participantRenameDebounceTimers[participantId] = setTimeout(() => {
        const trimmed = value.trim();
        if (!trimmed) return; // idem que pour son propre nom : on attend le blur si le champ est vide
        const p = participants.find(x => x.id === participantId);
        if (!p) return;
        p.name = trimmed;
        broadcastLobbyState();
        renderSeatAssignmentGrid();
    }, 300);
}

// Si l'hôte quitte le champ en le laissant vide, on retombe sur le nom par défaut
// de ce participant plutôt que de laisser un pseudo vide.
function uiRenameParticipantBlur(participantId, inputEl) {
    if (myRole !== 'host') return;
    clearTimeout(participantRenameDebounceTimers[participantId]);
    const p = participants.find(x => x.id === participantId);
    if (!p) return;
    const trimmed = inputEl.value.trim();
    p.name = trimmed || defaultParticipantName(participantId);
    broadcastLobbyState();
    renderLobby();
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
        const trimmed = input.value.trim();
        // Champ momentanément vide (l'utilisateur efface pour retaper autre chose) :
        // on n'impose pas le nom par défaut ici, seulement au blur (voir uiMyNameBlur).
        // Sinon on écrase ce que la personne est en train de saisir.
        if (!trimmed) return;

        const me = participants.find(p => p.id === myParticipantId);
        if (me) me.name = trimmed;

        if (myRole === 'host') {
            broadcastLobbyState();
            renderLobby();
        } else if (peerConn) {
            peerConn.send({ type: 'set-name', name: trimmed });
            renderLobby();
        }
    }, 300);
}

// Si l'utilisateur quitte le champ en le laissant vide, on retombe sur le nom par
// défaut (au lieu de laisser un pseudo vide affiché aux autres).
function uiMyNameBlur() {
    const input = document.getElementById('myNameInput');
    if (input.value.trim()) return;
    clearTimeout(nameUpdateDebounceTimer);
    const name = defaultParticipantName(myParticipantId);
    input.value = name;
    const me = participants.find(p => p.id === myParticipantId);
    if (me) me.name = name;

    if (myRole === 'host') {
        broadcastLobbyState();
        renderLobby();
    } else if (peerConn) {
        peerConn.send({ type: 'set-name', name });
        renderLobby();
    }
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

// Lit et parse un fichier de donnes, affichant tout de suite l'erreur ou l'avertissement
// "PARs non disponibles" s'il y a lieu. `onDone` reçoit le tableau de donnes parsées, ou
// `null` si la lecture/le parsing a échoué (l'erreur est alors déjà affichée).
function readAndValidateDealFile(file, onDone) {
    const errorEl = document.getElementById('hostSetupError');
    errorEl.style.display = 'none';

    const reader = new FileReader();

    reader.onload = () => {
        let parsedDeals;
        try {
            parsedDeals = parseDealFile(reader.result, file.name);
        } catch (err) {
            errorEl.textContent = '⚠️ ' + err.message;
            errorEl.style.display = 'block';
            onDone(null);
            return;
        }

        // Le calcul du PAR est optionnel dans le fichier : on prévient l'hôte s'il est
        // absent, mais ça ne doit pas empêcher de lancer la partie.
        if (!parsedDeals.some(d => d.par)) {
            errorEl.textContent = '⚠️ PARs non disponibles dans ce fichier — les contrats optimaux ne seront pas affichés.';
            errorEl.style.display = 'block';
        }

        onDone(parsedDeals);
    };

    reader.onerror = () => {
        errorEl.textContent = 'Impossible de lire ce fichier.';
        errorEl.style.display = 'block';
        onDone(null);
    };

    reader.readAsText(file);
}

// Appelé dès que l'hôte choisit (ou change) le fichier de donnes, pour parser et valider
// tout de suite — voir readAndValidateDealFile. L'hôte voit ainsi l'éventuel message
// pendant qu'il compose encore la table, et uiStartGameAsHost n'a plus qu'à réutiliser ce
// résultat (pendingParsedDeals) sans relire le fichier une seconde fois.
function uiHandleDealFileChosen() {
    const fileInput = document.getElementById('dealFileInput');
    pendingParsedDeals = null;
    pendingParsedFile = null;

    if (!fileInput.files || fileInput.files.length === 0) {
        document.getElementById('hostSetupError').style.display = 'none';
        return;
    }

    const file = fileInput.files[0];
    readAndValidateDealFile(file, (parsedDeals) => {
        pendingParsedFile = file;
        pendingParsedDeals = parsedDeals;
    });
}

function uiStartGameAsHost() {
    const fileInput = document.getElementById('dealFileInput');
    const errorEl = document.getElementById('hostSetupError');

    if (!fileInput.files || fileInput.files.length === 0) {
        errorEl.style.display = 'none';
        errorEl.textContent = 'Choisissez un fichier .pbn ou .lin.';
        errorEl.style.display = 'block';
        return;
    }

    const file = fileInput.files[0];

    const proceedWithDeals = (parsedDeals) => {
        if (!parsedDeals) return; // l'erreur est déjà affichée par readAndValidateDealFile

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

    // Cas normal : le fichier a déjà été lu et parsé au moment où il a été choisi (voir
    // uiHandleDealFileChosen) — pas besoin de le relire, et le message éventuel
    // (erreur ou avertissement PAR) est déjà affiché depuis ce moment-là.
    if (pendingParsedFile === file) {
        proceedWithDeals(pendingParsedDeals);
        return;
    }

    // Filet de sécurité si, pour une raison quelconque, le cache ne correspond pas au
    // fichier actuellement sélectionné (ex. écouteur 'change' non déclenché) : on relit.
    readAndValidateDealFile(file, proceedWithDeals);
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
            if (typeof msg.newLength === 'number') {
                auctionHistory.length = Math.max(0, Math.min(msg.newLength, auctionHistory.length));
            } else if (auctionHistory.length > 0) {
                auctionHistory.pop(); // compat, ne devrait plus arriver
            }
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
    renderHandDisplayOptionButtons();
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
                <span class="suit-symbol">${suitIconHtml(suit)}</span>
                <span class="cards">${formatRanksForDisplay(hand[suit]) || '—'}</span>
            </div>
        `).join('');

        const hcpBadge = showHcp ? `<span class="hand-hcp-badge">${computeHandHcp(hand)} HCP</span>` : '';
        const stateClass = showActiveState ? (seat === turnSeat ? 'hand-card-active' : 'hand-card-inactive') : '';

        return `
            <div class="hand-card ${stateClass}">
                <div class="hand-card-title">
                    <span class="hand-card-title-name">${seatFullName(seat)}</span>
                    ${hcpBadge}
                </div>
                <div class="hand-cards">${lines}</div>
            </div>
        `;
    }).join('');
}

// Rendu coloré d'une annonce en dehors de la boîte d'enchères (relevé, contrat final) :
// même logique de classe de couleur que les boutons (SUIT_CLASSES), avec l'icône SVG de
// la couleur à la place du caractère Unicode.
function formatCallCellHtml(call) {
    const b = parseBid(call);
    if (!b) return escapeHtml(formatCallForDisplay(call)); // Passe / X / XX : pas de couleur de suite
    const cls = SUIT_CLASSES[b.strain] || 'notrump';
    const label = b.strain === 'NT' ? 'SA' : suitIconHtml(b.strain);
    return `<span class="call-suit ${cls}">${b.level}${label}</span>`;
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
            const label = strain === 'NT' ? 'SA' : suitIconHtml(strain);
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
                <span class="suit-symbol">${suitIconHtml(suit)}</span>
                <span class="cards">${formatRanksForDisplay(hand[suit]) || '—'}</span>
            </div>
        `).join('');

        const hcpBadge = showHcp ? `<span class="hand-hcp-badge">${computeHandHcp(hand)} HCP</span>` : '';

        return `
            <div class="hand-card hand-${seat}">
                <div class="hand-card-title">
                    <span class="hand-card-title-name">${seatFullName(seat)}</span>
                    ${hcpBadge}
                </div>
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
        const labelHtml = strain === 'N' ? info.label : suitIconHtml(strain);
        const cells = DD_TABLE_SEAT_ORDER.map(pos => `<td>${tricksToContractLevel(ddTable[strain][pos])}</td>`).join('');
        return `<tr><th class="${info.class}">${labelHtml}</th>${cells}</tr>`;
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
        const strainLabel = contract.strain === 'NT' ? 'SA' : suitIconHtml(contract.strain);
        const contractHtml = `<span class="call-suit ${strainCls}">${contract.level}${strainLabel}${escapeHtml(contract.doubled)}</span>`;
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

function seatsOfParticipant(pid) {
    return SEATS.filter(seat => seatAssignment[seat] === pid);
}

// Détermine quelle entrée de l'historique une demande d'undo doit effectivement annuler.
// Pour un invité : la dernière annonce parmi celles produites par UN des sièges qu'il
// contrôle — pas forcément la toute dernière case du tableau, puisqu'un ou plusieurs
// robots ont pu passer automatiquement juste après (voir maybeAutoPass) si le joueur a
// mis un peu de temps à cliquer sur "undo". On renvoie alors l'index de SA dernière
// annonce ; applyUndoAsHost retirera cette annonce et tout ce qui a suivi (uniquement des
// passes robot, puisqu'aucun autre humain n'a pu jouer avant que ce ne soit à nouveau le
// tour de ce joueur).
// Renvoie -1 si ce participant n'a fait aucune annonce sur cette donne (rien à annuler).
//
// Exception : quand c'est L'HÔTE qui demande, on garde l'ancien comportement (annuler la
// toute dernière annonce du tableau, quel qu'en soit l'auteur) — l'hôte arbitre déjà toute
// la table (navigation libre entre donnes, etc.), et son bouton undo reste un simple
// "reculer d'un cran", sans distinction de siège.
function findUndoTargetIndex(requesterId, history) {
    if (requesterId === 'host') {
        return history.length - 1;
    }
    const seats = seatsOfParticipant(requesterId);
    for (let i = history.length - 1; i >= 0; i--) {
        if (seats.includes(history[i].seat)) return i;
    }
    return -1;
}

function guestIndexForParticipant(pid) {
    if (!pid || pid === 'host') return null;
    return Object.prototype.hasOwnProperty.call(guestIndexByToken, pid) ? guestIndexByToken[pid] : null;
}

// Participants humains "en face" du camp qui a fait l'annonce ciblée par l'undo, hors le
// demandeur — ce sont eux dont l'accord est requis pour annuler. `targetSeat` est le siège
// dont l'annonce va effectivement être retirée (voir findUndoTargetIndex), pas forcément
// le dernier siège de l'historique.
function humanOpponentsFor(requesterId, targetSeat) {
    const opposing = partnershipOf(targetSeat) === 'NS' ? partnershipSeats('EW') : partnershipSeats('NS');
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
        case 'nothing': return "Vous n'avez fait aucune annonce à annuler sur cette donne.";
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

    const targetIndex = findUndoTargetIndex(msg.requesterId, auctionHistory);
    if (targetIndex < 0) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'nothing' });
        return;
    }
    const targetSeat = auctionHistory[targetIndex].seat;

    const opponents = humanOpponentsFor(msg.requesterId, targetSeat);
    if (opponents.length === 0) {
        applyUndoAsHost({ boardIndex: msg.boardIndex, requesterId: msg.requesterId, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex });
        return;
    }

    hostPendingUndo = { requesterId: msg.requesterId, boardIndex: msg.boardIndex, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex };

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
    // On retire l'annonce ciblée (la dernière de CE joueur — voir findUndoTargetIndex) et
    // tout ce qui l'a suivie (uniquement des passes robot dans ce cas, voir plus haut),
    // plutôt qu'un simple pop() de la toute dernière case du tableau.
    auctionHistory.length = pending.targetIndex;
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    clearUndoUiState();
    peerConn.send({ type: 'undo-apply', boardIndex: pending.boardIndex, newLength: pending.targetIndex });
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

    const dealFileInput = document.getElementById('dealFileInput');
    if (dealFileInput) {
        dealFileInput.addEventListener('change', uiHandleDealFileChosen);
    }
});
