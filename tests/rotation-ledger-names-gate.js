'use strict';

// PLAY : les préférences d'affichage, dont Noms, survivent aux rotations 90°
// sur l'hôte et au rafraîchissement du client. Cette gate exerce le bouton
// et l'état local : le réseau ne doit jamais changer le choix de l'utilisateur.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function getFunction(name) {
    const start = app.indexOf('function ' + name + '(');
    assert(start >= 0, name + ' absent');
    const open = app.indexOf('{', start);
    let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
    for (let i = open; i < app.length; i++) {
        const c = app[i], n = app[i + 1];
        if (lineComment) { if (c === '\n') lineComment = false; continue; }
        if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && n === '/') { lineComment = true; continue; }
        if (c === '/' && n === '*') { blockComment = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        if (c === '}' && --depth === 0) return app.slice(start, i + 1);
    }
    throw Error('Corps incomplet de ' + name);
}

function button() {
    const classes = new Set();
    return {
        classList: {
            toggle(cls, enabled) { if (enabled) classes.add(cls); else classes.delete(cls); },
            contains(cls) { return classes.has(cls); }
        },
        attributes: {},
        style: {},
        setAttribute(k, v) { this.attributes[k] = v; }
    };
}
const buttons = {};
for (const id of [
    'frenchRanksToggleBtn', 'hcpToggleBtn', 'krToggleBtn', 'handStripToggleBtn',
    'ledgerNamesToggleBtn', 'hostSeeAllHandsBtn'
]) buttons[id] = button();

const store = new Map();
const saved = [];
const seats = ['N', 'E', 'S', 'W'];
const ctx = {
    document: { getElementById: id => buttons[id] || null },
    isTrueOriginalHost: () => true,
    useFrenchRanks: false, showHcp: true, showKr: false,
    showHandStrip: true, showLedgerNames: true, hostSeeAllHands: false,
    captureHandDisplayOptionViewportAnchor: () => null,
    restoreHandDisplayOptionViewportAnchor: () => {},
    saveBoolPref: (k, v) => { saved.push({ k, v }); store.set(k, v); },
    deals: null,
    renderAuctionLedger: () => {}, renderAllHandsDiagram: () => {},
    fadeVisibleLedgerNameTargets: () => {},
    SEATS: seats, SEAT_CLOCKWISE_NEXT: { N: 'E', E: 'S', S: 'W', W: 'N' },
    seatAssignment: { N: 'h', E: 'a', S: 'b', W: 'c' },
    myParticipantId: 'h',
    mySeats: ['N'], autoPassSeats: [],
    peerConn: { send() {} },
    flashSeatsRotatedToast: () => {},
    saveHostGameStateToStorage: () => {},
    renderLobby: () => {}
};
vm.createContext(ctx);
vm.runInContext([
    getFunction('renderHandDisplayOptionButtons'),
    getFunction('uiToggleLedgerNames'),
    getFunction('rotatedSeatAssignment'),
    getFunction('uiRotateSeatsClockwise'),
    // Les deux chemins (rotation émise/reçue) rappellent renderBoard().
    // Sa version ciblée ici vérifie uniquement les contrôles d'options.
    'function renderBoard() { renderHandDisplayOptionButtons(); }'
].join('\n'), ctx);
const names = buttons.ledgerNamesToggleBtn;
const assertNames = enabled => {
    assert.strictEqual(names.classList.contains('is-active'), enabled);
    assert.strictEqual(names.attributes['aria-pressed'], enabled ? 'true' : 'false');
};

// Première mise en place puis rotation hôte.
ctx.renderBoard();
assertNames(true);
for (let i = 0; i < 4; i++) {
    ctx.uiRotateSeatsClockwise();
    assertNames(true);
    assert.strictEqual(ctx.showLedgerNames, true, 'La rotation modifie la préférence !');
}
assert.strictEqual(ctx.seatAssignment.N, 'h');
assert.strictEqual(saved.length, 0, 'La rotation ne doit pas réécrire de préférence');

// Bouton désactivé, puis rotation : doit rester désactivé.
ctx.uiToggleLedgerNames();
assertNames(false);
assert.strictEqual(saved.length, 1);
assert.strictEqual(store.get('bridgeBidShowLedgerNames'), false);
ctx.uiRotateSeatsClockwise();
assertNames(false);
assert.strictEqual(ctx.showLedgerNames, false);

// Le bouton activé de nouveau doit survivre à un re-render invité.
// Simule une classe DOM perdue lors d'un changement de vue.
ctx.uiToggleLedgerNames();
assertNames(true);
names.classList.toggle('is-active', false);
names.setAttribute('aria-pressed', 'false');
ctx.renderBoard();
assertNames(true);

// Idem si l'état de la préférence est désactivé.
ctx.uiToggleLedgerNames();
names.classList.toggle('is-active', true);
names.setAttribute('aria-pressed', 'true');
ctx.renderBoard();
assertNames(false);

console.log('PLAY : Noms après rotation 90° gate PASS');
