// app.js — État de l'application et rendu de l'interface.
// S'appuie sur bidding-rules.js (logique pure), deal-parser.js (lecture PBN/LIN)
// et peer-connection.js (connexion WebRTC) chargés avant ce fichier.
//
// MODES DE JEU :
//   'pair'     — 2 joueurs : hôte = Nord ou Sud (à son choix), invité = l'autre.
//                Est-Ouest est joué par un robot qui passe systématiquement.
//   'diagonal' — 2 joueurs : hôte = Sud+Ouest ou Nord+Est (à son choix), invité = la paire complémentaire.
//   'master'   — 3 joueurs : hôte = Est+Ouest ("maître du jeu"), 2 invités = Nord et Sud.
//                Seul l'hôte peut naviguer entre les donnes (recommencer / donne suivante).
//   'four'     — 4 joueurs : hôte = Nord, 3 invités = Est, Sud, Ouest (dans l'ordre de connexion).
//                Chacun ne voit que sa propre main.
//
// TOPOLOGIE : à partir de 2 invités (modes 'master' et 'four'), les invités ne sont jamais
// connectés entre eux — l'hôte relaie tout message reçu d'un invité vers les autres
// (voir relayIfHost). Ce mécanisme est générique et ne nécessite aucune logique spécifique
// par mode : il suffit que l'hôte relaie tout ce qu'il reçoit, aux autres que l'expéditeur.

const GAME_MODES = {
    pair: { maxGuests: 1 },
    diagonal: { maxGuests: 1 },
    master: { maxGuests: 2 },
    four: { maxGuests: 3 }
};

const ALL_SEATS_PAIRS = { NS: ['N', 'S'], EW: ['E', 'W'] };
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLASSES = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SEAT_FULL_NAME = { N: 'Nord', E: 'Est', S: 'Sud', W: 'Ouest' };
const VULN_LABEL = { None: 'Non vulnérable', NS: 'NS vulnérable', EW: 'EO vulnérable', Both: 'Tous vulnérables' };

let peerConn = null;
let gameMode = 'pair';
let myRole = null;       // 'host' | 'guest'
let mySeats = null;      // sièges contrôlés par ce joueur, ex: ['N'], ['N','S'], ['S','W']...
let autoPassSeats = [];  // sièges joués par le robot "passe" (mode 'pair' uniquement)
let deals = null;        // tableau de donnes parsées
let boardIndex = 0;
let auctionHistory = []; // historique de la donne en cours : [{seat, call}, ...]

function currentDeal() {
    return deals[boardIndex];
}

// Seul le "maître du jeu" (mode 'master') a une restriction de contrôle : dans tous les
// autres modes, n'importe quel joueur peut recommencer l'enchère ou passer à la donne suivante.
function canControlBoard() {
    if (gameMode === 'master') return myRole === 'host';
    return true;
}

// Calcule qui joue quoi selon le mode choisi et, le cas échéant, le choix de l'hôte.
function computeSeatAssignment(mode, hostChoice) {
    if (mode === 'pair') {
        const hostSeats = [hostChoice]; // 'N' ou 'S'
        const guestSeat = hostChoice === 'N' ? 'S' : 'N';
        return { hostSeats, guestSeatsList: [[guestSeat]], autoPassSeats: ['E', 'W'] };
    }
    if (mode === 'diagonal') {
        const hostSeats = hostChoice === 'SW' ? ['S', 'W'] : ['N', 'E']; // hostChoice: 'SW' ou 'NE'
        const guestSeats = hostChoice === 'SW' ? ['N', 'E'] : ['S', 'W'];
        return { hostSeats, guestSeatsList: [guestSeats], autoPassSeats: [] };
    }
    if (mode === 'master') {
        return { hostSeats: ['E', 'W'], guestSeatsList: [['N'], ['S']], autoPassSeats: [] };
    }
    if (mode === 'four') {
        return { hostSeats: ['N'], guestSeatsList: [['E'], ['S'], ['W']], autoPassSeats: [] };
    }
    return { hostSeats: ['N', 'S'], guestSeatsList: [['E', 'W']], autoPassSeats: [] };
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

function uiCreateRoom() {
    document.getElementById('landingError').style.display = 'none';
    if (peerConn) peerConn.destroy();

    gameMode = document.getElementById('gameModeSelect').value;
    const maxGuests = GAME_MODES[gameMode].maxGuests;

    peerConn = new BridgePeerConnection({
        onOpen: (role, roomCode) => {
            document.getElementById('roomCodeDisplay').textContent = roomCode;
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode);
            document.getElementById('shareLinkInput').value = url.toString();
            document.getElementById('roomCodeBadge').textContent = 'Code : ' + roomCode;
            document.getElementById('roomCodeBadge').style.display = 'inline';
            document.getElementById('hostWaitingStatus').textContent = maxGuests === 1
                ? "⏳ En attente de connexion de l'adversaire..."
                : `⏳ En attente des joueurs... (0/${maxGuests} connectés)`;
            showScreen('screen-host-waiting');
        },
        onGuestConnected: (guestIndex, connectedCount, maxG) => {
            setConnectionStatus(true);
            document.getElementById('hostWaitingStatus').textContent = maxG === 1
                ? "✅ Adversaire connecté !"
                : `⏳ En attente des joueurs... (${connectedCount}/${maxG} connectés)`;
        },
        onAllConnected: () => {
            document.getElementById('hostWaitingStatus').textContent = maxGuests === 1
                ? "✅ Adversaire connecté !"
                : `✅ Tous les joueurs sont connectés ! (${maxGuests + 1} au total)`;
            renderHostSeatChoice(gameMode);
            document.getElementById('hostSetupPanel').style.display = 'block';
        },
        onPeerDisconnected: () => {
            setConnectionStatus(peerConn ? peerConn.isConnected() : false);
        },
        onSlowConnection: () => {
            document.getElementById('hostWaitingStatus').innerHTML =
                "⏳ Toujours en attente... Vérifie que le(s) autre(s) joueur(s) ont bien collé le code exact, " +
                "et que vous êtes tous connectés à internet.";
        },
        onTimeout: () => {
            document.getElementById('hostWaitingStatus').innerHTML =
                "⚠️ La connexion n'a pas abouti après 45 secondes. Ouvre la console (F12) pour plus de détails, " +
                "et réessaie (recharge la page pour générer un nouveau code).";
        },
        onData: handlePeerData,
        onError: (err) => {
            showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
        }
    });
    peerConn.createRoom(maxGuests);
}

function uiJoinRoom() {
    document.getElementById('landingError').style.display = 'none';
    if (peerConn) peerConn.destroy();
    const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
    if (code.length !== 4) {
        showLandingError('Entrez un code à 4 lettres.');
        return;
    }

    peerConn = new BridgePeerConnection({
        onOpen: (role, roomCode) => {
            document.getElementById('roomCodeBadge').textContent = 'Code : ' + roomCode;
            document.getElementById('roomCodeBadge').style.display = 'inline';
            showScreen('screen-guest-waiting');
        },
        onGuestConnected: () => {
            setConnectionStatus(true);
            document.getElementById('guestWaitingTitle').textContent = 'Connecté !';
            document.getElementById('guestWaitingText').textContent = "En attente que l'hôte charge les donnes...";
        },
        onPeerDisconnected: () => {
            setConnectionStatus(false);
        },
        onSlowConnection: () => {
            document.getElementById('guestWaitingText').innerHTML =
                "⏳ Ça prend plus de temps que d'habitude... Vérifie que le code est correct et que " +
                "l'hôte a bien laissé sa page ouverte.";
        },
        onTimeout: () => {
            showScreen('screen-landing');
            showLandingError(
                "⚠️ La connexion n'a pas abouti après 45 secondes. Vérifie le code, que l'hôte est " +
                "toujours connecté, et ouvre la console (F12) pour plus de détails avant de réessayer."
            );
        },
        onData: handlePeerData,
        onError: (err) => {
            showScreen('screen-landing');
            if (err && err.type === 'peer-unavailable') {
                showLandingError("Aucune partie trouvée avec ce code. Vérifiez le code ou demandez à l'hôte de le repartager.");
            } else {
                showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
            }
        }
    });
    peerConn.joinRoom(code);
}

function uiCopyShareLink() {
    const input = document.getElementById('shareLinkInput');
    input.select();
    input.setSelectionRange(0, 99999);
    if (navigator.clipboard) {
        navigator.clipboard.writeText(input.value).catch(() => {});
    }
}

// Génère le choix de siège adapté au mode (ou un simple texte informatif quand il n'y a
// pas de choix à faire, l'assignation étant fixe).
function renderHostSeatChoice(mode) {
    const container = document.getElementById('hostSeatChoiceContainer');
    if (mode === 'pair') {
        container.innerHTML = `
            <div class="form-group">
                <label>Votre siège</label>
                <div class="seat-choice">
                    <label><input type="radio" name="hostSeatChoice" value="N" checked> Nord</label>
                    <label><input type="radio" name="hostSeatChoice" value="S"> Sud</label>
                </div>
            </div>
        `;
    } else if (mode === 'diagonal') {
        container.innerHTML = `
            <div class="form-group">
                <label>Votre paire</label>
                <div class="seat-choice">
                    <label><input type="radio" name="hostSeatChoice" value="SW" checked> Sud + Ouest</label>
                    <label><input type="radio" name="hostSeatChoice" value="NE"> Nord + Est</label>
                </div>
            </div>
        `;
    } else if (mode === 'master') {
        container.innerHTML = `<div class="seat-info-text">Vous jouez <strong>Est-Ouest</strong> (maître du jeu). Les deux invités joueront Nord et Sud.</div>`;
    } else if (mode === 'four') {
        container.innerHTML = `<div class="seat-info-text">Vous jouez <strong>Nord</strong>. Les invités joueront Est, Sud et Ouest (dans l'ordre de connexion).</div>`;
    }
}

function getHostSeatChoiceValue(mode) {
    if (mode === 'pair' || mode === 'diagonal') {
        const checked = document.querySelector('input[name="hostSeatChoice"]:checked');
        if (checked) return checked.value;
        return mode === 'pair' ? 'N' : 'SW';
    }
    return null;
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

        const hostChoice = getHostSeatChoiceValue(gameMode);
        const assignment = computeSeatAssignment(gameMode, hostChoice);

        deals = parsedDeals;
        mySeats = assignment.hostSeats;
        autoPassSeats = assignment.autoPassSeats;
        myRole = 'host';
        boardIndex = 0;
        auctionHistory = [];

        assignment.guestSeatsList.forEach((seats, guestIndex) => {
            peerConn.send({ type: 'deals', deals, yourSeats: seats, gameMode }, guestIndex);
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
        case 'deals': {
            deals = msg.deals;
            mySeats = msg.yourSeats;
            gameMode = msg.gameMode;
            myRole = 'guest';
            boardIndex = 0;
            auctionHistory = [];
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
            renderAuctionLedger();
            renderBiddingBox();
            checkAuctionEnd();
            relayIfHost(msg, guestIndex);
            break;
        }

        case 'goto-board': {
            if (!deals) return;
            boardIndex = msg.boardIndex;
            auctionHistory = [];
            renderBoard();
            relayIfHost(msg, guestIndex);
            break;
        }
    }
}

// Quand l'hôte reçoit un message d'un invité, il le relaie aux AUTRES invités (les invités
// ne sont jamais connectés entre eux). Générique : ne fait rien de plus en mode 2 joueurs
// (il n'y a alors personne d'autre à qui relayer), et rien du tout côté invité.
function relayIfHost(msg, fromGuestIndex) {
    if (myRole === 'host') {
        peerConn.sendExcept(msg, fromGuestIndex);
    }
}

// ===== Robot "passe automatique" (mode 'pair' uniquement) =====
//
// Seul l'hôte injecte les passes automatiques (pour ne jamais les déclencher en double),
// puis les diffuse comme n'importe quelle annonce — l'invité les reçoit et les applique
// normalement via le cas 'call' de handlePeerData, sans rien savoir de spécial.
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
        if (auctionHistory.length !== historyLengthAtSchedule) return; // quelque chose a changé entretemps
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
    maybeAutoPass();
}

function updateBoardControlVisibility() {
    const resetBtn = document.getElementById('resetAuctionBtn');
    if (resetBtn) resetBtn.style.display = canControlBoard() ? '' : 'none';
}

function renderGameHeader() {
    const deal = currentDeal();
    document.getElementById('boardNumberLabel').textContent = `Donne #${deal.board} (${boardIndex + 1}/${deals.length})`;
    document.getElementById('dealerVulnLabel').textContent =
        `Donneur : ${seatFullName(deal.dealer)} · ${VULN_LABEL[deal.vulnerable]} · Vous jouez : ${mySeats.map(seatFullName).join(' + ')}`;
}

function renderMyHands() {
    const deal = currentDeal();
    const container = document.getElementById('myHandsContainer');

    container.innerHTML = mySeats.map(seat => {
        const hand = deal.hands[seat];
        const lines = ['S', 'H', 'D', 'C'].map(suit => `
            <div class="card-line">
                <span class="suit-symbol ${SUIT_CLASSES[suit]}">${SUIT_SYMBOLS[suit]}</span>
                <span class="cards">${hand[suit] || '—'}</span>
            </div>
        `).join('');

        return `
            <div class="hand-card">
                <div class="hand-card-title">${seatFullName(seat)}</div>
                <div class="hand-cards">${lines}</div>
            </div>
        `;
    }).join('');
}

function renderAuctionLedger() {
    const deal = currentDeal();
    const header = document.getElementById('auctionLedgerHeader');
    header.innerHTML = SEATS.map(s =>
        `<th class="${s === deal.dealer ? 'dealer-col' : ''}">${s}${s === deal.dealer ? ' (D)' : ''}</th>`
    ).join('');

    const dealerIdx = SEATS.indexOf(deal.dealer);
    const slots = new Array(dealerIdx).fill('');
    auctionHistory.forEach(entry => slots.push(formatCallForDisplay(entry.call)));

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
    const myTurn = mySeats.includes(turnSeat);

    turnPanel.textContent = myTurn
        ? `À vous d'enchérir (${seatFullName(turnSeat)})`
        : `En attente de ${seatFullName(turnSeat)}...`;
    turnPanel.className = 'turn-indicator ' + (myTurn ? 'my-turn' : 'their-turn');

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
    if (!mySeats.includes(turnSeat)) return;
    if (!isCallLegal(auctionHistory, call, turnSeat)) return;

    applyCall(turnSeat, call);
    peerConn.send({ type: 'call', boardIndex, seat: turnSeat, call });
}

function applyCall(seat, call) {
    auctionHistory.push({ seat, call });
    renderAuctionLedger();
    renderBiddingBox();
    checkAuctionEnd();
    maybeAutoPass();
}

function checkAuctionEnd() {
    const resultEl = document.getElementById('contractResult');
    const nextPanel = document.getElementById('nextBoardPanel');

    if (!isAuctionOver(auctionHistory)) {
        resultEl.style.display = 'none';
        nextPanel.style.display = 'none';
        return;
    }

    const contract = determineContract(auctionHistory);
    resultEl.style.display = 'block';
    if (!contract) {
        resultEl.innerHTML = "↩️ Donne passée — personne n'a annoncé.";
    } else {
        resultEl.innerHTML = `Contrat final : <strong>${contract.contractString}</strong> par <strong>${seatFullName(contract.declarer)}</strong>`;
    }

    const isLastBoard = boardIndex >= deals.length - 1;
    const iCanNavigate = canControlBoard();
    nextPanel.style.display = (isLastBoard || !iCanNavigate) ? 'none' : 'block';

    if (isLastBoard) {
        resultEl.innerHTML += '<div class="info-text">Dernière donne du fichier chargé.</div>';
    } else if (!iCanNavigate) {
        resultEl.innerHTML += '<div class="info-text">En attente que le maître du jeu passe à la donne suivante.</div>';
    }
}

function uiResetAuction() {
    if (!canControlBoard()) return;
    auctionHistory = [];
    renderAuctionLedger();
    renderBiddingBox();
    checkAuctionEnd();
    peerConn.send({ type: 'reset-auction', boardIndex });
}

function uiNextBoard() {
    if (!canControlBoard()) return;
    if (boardIndex >= deals.length - 1) return;
    boardIndex++;
    auctionHistory = [];
    renderBoard();
    peerConn.send({ type: 'goto-board', boardIndex });
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
