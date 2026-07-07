// bidding-rules.js — Logique pure des enchères au bridge (aucune dépendance au DOM).
//
// Une "call" est une chaîne parmi : "PASS", "X", "XX", ou une enchère chiffrée
// "1C","1D","1H","1S","1NT","2C", ... "7NT".
// L'historique (history) est un tableau de { seat, call }, seat ∈ {N,E,S,W}.

const SEATS = ['N', 'E', 'S', 'W'];
const STRAINS = ['C', 'D', 'H', 'S', 'NT'];
const STRAIN_RANK = { C: 0, D: 1, H: 2, S: 3, NT: 4 };
const STRAIN_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'SA' };

function isPass(call) { return call === 'PASS'; }
function isDouble(call) { return call === 'X'; }
function isRedouble(call) { return call === 'XX'; }
function isBidCall(call) { return !isPass(call) && !isDouble(call) && !isRedouble(call); }

function parseBid(call) {
    // "1C" -> {level:1, strain:'C'} ; "7NT" -> {level:7, strain:'NT'}
    const m = call.match(/^([1-7])(NT|C|D|H|S)$/);
    if (!m) return null;
    return { level: parseInt(m[1], 10), strain: m[2] };
}

function bidRank(call) {
    const b = parseBid(call);
    if (!b) return -1;
    return (b.level - 1) * 5 + STRAIN_RANK[b.strain];
}

function partnershipOf(seat) {
    return (seat === 'N' || seat === 'S') ? 'NS' : 'EW';
}

function seatAfter(seat) {
    return SEATS[(SEATS.indexOf(seat) + 1) % 4];
}

function currentTurnSeat(dealer, history) {
    const dealerIdx = SEATS.indexOf(dealer);
    return SEATS[(dealerIdx + history.length) % 4];
}

function getLastNonPassCall(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (!isPass(history[i].call)) return history[i];
    }
    return null;
}

function getLastActualBid(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (isBidCall(history[i].call)) return history[i];
    }
    return null;
}

// Vrai si l'enchère est terminée (3 passes consécutives après une enchère, ou 4 passes
// d'entrée = donne passée sans aucune annonce).
function isAuctionOver(history) {
    const hasAnyCall = history.some(c => isBidCall(c.call));
    if (!hasAnyCall) {
        return history.length === 4;
    }
    if (history.length < 3) return false;
    return history.slice(-3).every(c => isPass(c.call));
}

function isPassedOut(history) {
    return isAuctionOver(history) && !history.some(c => isBidCall(c.call));
}

// Détermine si `call` est légal pour `callerSeat`, compte tenu de l'historique.
// Le contrôle "est-ce bien le tour de callerSeat ?" est fait séparément par l'appelant
// (voir currentTurnSeat) : cette fonction ne vérifie que la légalité intrinsèque du call.
function isCallLegal(history, call, callerSeat) {
    if (isAuctionOver(history)) return false;

    if (isPass(call)) return true;

    const lastNonPass = getLastNonPassCall(history);

    if (isDouble(call)) {
        if (!lastNonPass) return false;
        if (!isBidCall(lastNonPass.call)) return false; // déjà contré/surcontré
        return partnershipOf(lastNonPass.seat) !== partnershipOf(callerSeat);
    }

    if (isRedouble(call)) {
        if (!lastNonPass) return false;
        if (!isDouble(lastNonPass.call)) return false;
        return partnershipOf(lastNonPass.seat) !== partnershipOf(callerSeat);
    }

    // Enchère chiffrée : doit être strictement supérieure à la dernière enchère chiffrée
    const lastBid = getLastActualBid(history);
    if (!lastBid) return true;
    return bidRank(call) > bidRank(lastBid.call);
}

// Détermine le contrat final à partir d'un historique terminé.
// Renvoie null si la donne a été passée (personne n'a annoncé).
function determineContract(history) {
    const finalBid = getLastActualBid(history);
    if (!finalBid) return null;

    const winningSide = partnershipOf(finalBid.seat);
    const strain = parseBid(finalBid.call).strain;

    // Le déclarant est le premier joueur du camp gagnant à avoir annoncé cette couleur/SA
    let declarer = finalBid.seat;
    for (const entry of history) {
        if (isBidCall(entry.call) && partnershipOf(entry.seat) === winningSide) {
            const b = parseBid(entry.call);
            if (b.strain === strain) {
                declarer = entry.seat;
                break;
            }
        }
    }

    // Statut contré/surcontré : chercher après la dernière enchère chiffrée
    const finalBidIndex = history.lastIndexOf(finalBid);
    const after = history.slice(finalBidIndex + 1);
    let doubled = '';
    if (after.some(c => isRedouble(c.call))) doubled = 'XX';
    else if (after.some(c => isDouble(c.call))) doubled = 'X';

    return {
        level: parseBid(finalBid.call).level,
        strain,
        declarer,
        doubled,
        contractString: `${parseBid(finalBid.call).level}${STRAIN_SYMBOL[strain]}${doubled}`
    };
}

function formatCallForDisplay(call) {
    if (isPass(call)) return 'Passe';
    if (isDouble(call)) return 'X';
    if (isRedouble(call)) return 'XX';
    const b = parseBid(call);
    return `${b.level}${STRAIN_SYMBOL[b.strain]}`;
}

// Génère la liste ordonnée de toutes les enchères chiffrées possibles (1C..7NT),
// utile pour construire la boîte d'enchères.
function allBidCalls() {
    const calls = [];
    for (let level = 1; level <= 7; level++) {
        for (const strain of STRAINS) {
            calls.push(`${level}${strain}`);
        }
    }
    return calls;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SEATS, STRAINS, STRAIN_RANK, STRAIN_SYMBOL,
        isPass, isDouble, isRedouble, isBidCall,
        parseBid, bidRank, partnershipOf, seatAfter, currentTurnSeat,
        getLastNonPassCall, getLastActualBid, isAuctionOver, isPassedOut,
        isCallLegal, determineContract, formatCallForDisplay, allBidCalls
    };
}
