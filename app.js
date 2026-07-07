// app.js — État de l'application et rendu de l'interface.
// S'appuie sur bidding-rules.js (logique pure), deal-parser.js (lecture PBN/LIN)
// et peer-connection.js (connexion WebRTC) chargés avant ce fichier.

const ALL_SEATS_PAIRS = { NS: ['N', 'S'], EW: ['E', 'W'] };
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLASSES = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SEAT_FULL_NAME = { N: 'Nord', E: 'Est', S: 'Sud', W: 'Ouest' };
const VULN_LABEL = { None: 'Non vulnérable', NS: 'NS vulnérable', EW: 'EO vulnérable', Both: 'Tous vulnérables' };

let peerConn = null;
let mySeats = null;      // ['N','S'] ou ['E','W'] — les deux mains que ce joueur voit et contrôle
let deals = null;        // tableau de donnes parsées
let boardIndex = 0;
let auctionHistory = []; // historique de la donne en cours : [{seat, call}, ...]

function currentDeal() {
    return deals[boardIndex];
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

// ===== Écran d'accueil : créer / rejoindre =====

function uiCreateRoom() {
    document.getElementById('landingError').style.display = 'none';
    if (peerConn) peerConn.destroy();

    peerConn = new BridgePeerConnection({
        onOpen: (role, roomCode) => {
            document.getElementById('roomCodeDisplay').textContent = roomCode;
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode);
            document.getElementById('shareLinkInput').value = url.toString();
            document.getElementById('roomCodeBadge').textContent = 'Code : ' + roomCode;
            document.getElementById('roomCodeBadge').style.display = 'inline';
            showScreen('screen-host-waiting');
        },
        onPeerConnected: () => {
            setConnectionStatus(true);
            document.getElementById('hostWaitingStatus').textContent = "✅ Adversaire connecté !";
            document.getElementById('hostSetupPanel').style.display = 'block';
        },
        onPeerDisconnected: () => {
            setConnectionStatus(false);
        },
        onSlowConnection: () => {
            document.getElementById('hostWaitingStatus').innerHTML =
                "⏳ Toujours en attente... Vérifie que l'autre joueur a bien collé le code exact, " +
                "et que vous êtes tous les deux connectés à internet.";
        },
        onTimeout: () => {
            document.getElementById('hostWaitingStatus').innerHTML =
                "⚠️ La connexion n'a pas abouti après 20 secondes. Ouvre la console (F12) pour plus de détails, " +
                "et réessaie (recharge la page pour générer un nouveau code).";
        },
        onData: handlePeerData,
        onError: (err) => {
            showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
        }
    });
    peerConn.createRoom();
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
        onPeerConnected: () => {
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
                "⚠️ La connexion n'a pas abouti après 20 secondes. Vérifie le code, que l'hôte est " +
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

        const seatChoice = document.querySelector('input[name="hostSeatChoice"]:checked').value;
        deals = parsedDeals;
        mySeats = ALL_SEATS_PAIRS[seatChoice];
        boardIndex = 0;
        auctionHistory = [];

        peerConn.send({ type: 'deals', deals, hostSeats: mySeats });
        enterGameScreen();
    };

    reader.onerror = () => {
        errorEl.textContent = 'Impossible de lire ce fichier.';
        errorEl.style.display = 'block';
    };

    reader.readAsText(file);
}

// ===== Réception des messages de l'autre joueur =====

function handlePeerData(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'deals': {
            deals = msg.deals;
            const hostIsNS = msg.hostSeats.includes('N');
            mySeats = hostIsNS ? ALL_SEATS_PAIRS.EW : ALL_SEATS_PAIRS.NS;
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
            break;
        }

        case 'reset-auction': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            auctionHistory = [];
            renderAuctionLedger();
            renderBiddingBox();
            checkAuctionEnd();
            break;
        }

        case 'goto-board': {
            if (!deals) return;
            boardIndex = msg.boardIndex;
            auctionHistory = [];
            renderBoard();
            break;
        }
    }
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
}

function renderGameHeader() {
    const deal = currentDeal();
    document.getElementById('boardNumberLabel').textContent = `Donne #${deal.board} (${boardIndex + 1}/${deals.length})`;
    document.getElementById('dealerVulnLabel').textContent =
        `Donneur : ${seatFullName(deal.dealer)} · ${VULN_LABEL[deal.vulnerable]}`;
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
        : `En attente de l'adversaire (${seatFullName(turnSeat)})...`;
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
    nextPanel.style.display = isLastBoard ? 'none' : 'block';
    if (isLastBoard) {
        resultEl.innerHTML += '<div class="info-text">Dernière donne du fichier chargé.</div>';
    }
}

function uiResetAuction() {
    auctionHistory = [];
    renderAuctionLedger();
    renderBiddingBox();
    checkAuctionEnd();
    peerConn.send({ type: 'reset-auction', boardIndex });
}

function uiNextBoard() {
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
    }
});
