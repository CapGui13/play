'use strict';
// PLAY : maintien du basculement manuel PAR/Encheres, sans PAR auto.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'ui-events.js'), 'utf8');

function extract(name) {
    const start = app.indexOf('function ' + name + '(');
    assert(start >= 0, name + ' absent');
    const open = app.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < app.length; i++) {
        if (app[i] === '{') depth++;
        if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
    }
    throw new Error('corps incomplet : ' + name);
}

// Plus de bouton PAR auto ni de raccourci fantome sur aucun affichage.
for (const s of [html, css, ui, app]) {
    assert(!/autoPar|auto-par|AutoPar|PAR auto/.test(s), 'reference PAR auto encore presente');
}
assert(html.includes('id="parBiddingToggleBtn"') &&
    html.includes('data-ui-click="toggle-par"') &&
    html.includes('Voir le PAR'), 'bouton manuel PAR supprime');
assert(ui.includes("case 'toggle-par': return call('uiToggleParBiddingView');"),
    'action manuelle PAR supprimee');
assert(app.includes('showParDuringAuction ? \'🎴 Voir les enchères\' : \'📊 Voir le PAR\''),
    'libelle du bouton manuel non synchronise');
assert(!app.includes("loadBoolPref('bridgeBidAutoParFourHands'"),
    'ancienne preference continue a piloter la vue');

const deal = { board: 1, statisticalParMode: true, ddTable: { computed: true } };
const c = {
    deals: [deal],
    auctionHistory: [],
    current: deal,
    mySeats: ['N'],
    hostSeeAllHands: true,
    showParDuringAuction: false,
    isTrueOriginalHost: () => true,
    isKibbitz: () => false,
    isAuctionOver: () => false,
    currentDeal() { return c.current; },
    renderBiddingBox() { c.renderCount = (c.renderCount || 0) + 1; },
    checkAuctionEnd() { c.refreshCount = (c.refreshCount || 0) + 1; }
};
vm.createContext(c);
vm.runInContext([
    'isFourHandsModeLocallyActive',
    'canViewExactParDuringAuction',
    'uiToggleParBiddingView'
].map(extract).join('\n'), c);

// Vue 4 mains => acces manuel, meme avec les chances statistiques actives.
assert(c.canViewExactParDuringAuction(deal, true), 'PAR manuel interdit en 4 mains');
assert(!c.canViewExactParDuringAuction(deal, false),
    'PAR statistique accessible avant activation des 4 mains');
assert(c.isFourHandsModeLocallyActive(), 'mode 4 mains non detecte');
assert(!c.showParDuringAuction, 'PAR ouvert automatiquement sans action');
c.uiToggleParBiddingView();
assert(c.showParDuringAuction && c.refreshCount === 1, 'bouton Voir le PAR inoperant');
c.uiToggleParBiddingView();
assert(!c.showParDuringAuction && c.refreshCount === 2,
    'bouton Voir les encheres inoperant');

// Un calcul tardif / rerender ne declenche plus jamais le PAR automatiquement :
assert(!app.includes('syncAutoParForCurrentDeal('), 'reactivation automatique encore possible');
assert(!c.showParDuringAuction, 'retour manuel non conserve');

// Le bouton n'a jamais acces au DD avant que la table soit disponible.
deal.ddTable = null;
c.uiToggleParBiddingView();
assert(!c.showParDuringAuction, 'PAR affiche alors que DD est encore en calcul');
deal.ddTable = { computed: true };

// Le privilege d'hote est obligatoire ; un joueur ordinaire n'a pas cette option.
c.isTrueOriginalHost = () => false;
c.hostSeeAllHands = false;
assert(!c.isFourHandsModeLocallyActive(), 'quatre mains ouvertes par joueur non autorise');
c.uiToggleParBiddingView();
assert(!c.showParDuringAuction, 'PAR revele au joueur ordinaire');

// Un spectateur sans siege conserve l'acces deja prevu.
c.isKibbitz = () => true;
assert(c.canViewExactParDuringAuction(deal, true), 'PAR refuse au spectateur');
assert(c.isFourHandsModeLocallyActive(), '4 mains refuses au spectateur');

// Régression PAR après déplacement réseau : seuls les changements de donne
// réinitialisent la bascule manuelle, comme le chemin local gotoBoard().
const remoteBoardHelper = extract('resetParViewOnRemoteBoardChange');
vm.runInContext(remoteBoardHelper, c);
c.showParDuringAuction = true;
c.resetParViewOnRemoteBoardChange(0, 0, 1, 1); // resync sans mouvement
assert(c.showParDuringAuction, 'resync sur la meme donne ferme le PAR manuel');
c.resetParViewOnRemoteBoardChange(0, 1, 1, 2);
assert(!c.showParDuringAuction, 'goto-board distant conserve le PAR ancien');

c.showParDuringAuction = true;
c.resetParViewOnRemoteBoardChange(0, 0, 1, 2); // snapshot remplace la donne
assert(!c.showParDuringAuction, 'resync remplacant la donne conserve le PAR ancien');

c.showParDuringAuction = true;
c.resetParViewOnRemoteBoardChange(0, 0, 2, 2); // meme donne : preference conservee
assert(c.showParDuringAuction, 'double reception sur la meme donne change la vue');

const gotoCase = app.slice(app.indexOf("case 'goto-board': {"), app.indexOf('// --- Demande d\'annulation', app.indexOf("case 'goto-board': {")));
const resyncCase = app.slice(app.indexOf("case 'resync': {"), app.indexOf("case 'call': {", app.indexOf("case 'resync': {")));
assert(gotoCase.includes('resetParViewOnRemoteBoardChange('), 'goto-board distant sans reset PAR');
assert(gotoCase.indexOf('resetParViewOnRemoteBoardChange(') < gotoCase.indexOf('boardIndex = targetBoardIndex'),
    'reset du PAR effectue apres le changement de donne');
assert(gotoCase.indexOf('if (deferredRoomMode)') < gotoCase.indexOf('resetParViewOnRemoteBoardChange('),
    'reception differee modifie le PAR alors que goto-board doit etre ignore');
assert(resyncCase.includes('resetParViewOnRemoteBoardChange(') &&
    resyncCase.indexOf('resetParViewOnRemoteBoardChange(') < resyncCase.indexOf('enterGameScreen();'),
    'resync ne restaure pas le PAR avant le rendu');
assert(app.includes('function gotoBoard(newIndex) {\n    showParDuringAuction = false;'),
    'navigation locale a perdu son reset PAR');
c.showParDuringAuction = false;

// Parcourir aussi les vrais blocs de réception P2P, avec les rendus/réseau simulés.
// Le simple test de helper ne détecterait pas un appel oublié dans le switch.
const networkContext = {
    showParDuringAuction: true,
    boardIndex: 0,
    deals: [{ board: 1, auctionHistory: [] }, { board: 2, auctionHistory: [] }],
    deferredRoomMode: false,
    chatPanelOpen: true,
    guestIndex: 0,
    isNewJoiner: false,
    recordSyncTrace() {},
    rejectPeerProtocolMessage() { networkContext.rejected = (networkContext.rejected || 0) + 1; },
    clearUndoUiState() {},
    renderBoard() { networkContext.rendered = (networkContext.rendered || 0) + 1; },
    positionNextBoardAfterParNavigation() {},
    relayIfHost() {},
    enterGameScreen() { networkContext.entered = (networkContext.entered || 0) + 1; },
    announceContractChanceCapability() {},
    primeDeferredGuestCloudAccess() {},
    startDeferredPolling() {},
    uiToggleChat() { throw Error('ouverture du chat non attendue'); }
};
vm.createContext(networkContext);
vm.runInContext(
    remoteBoardHelper +
    '\nfunction receiveBoardNetwork(msg) { switch (msg.type) {\n' +
    gotoCase + '\n' + resyncCase + '\n} }',
    networkContext
);
networkContext.receiveBoardNetwork({ type: 'goto-board', boardIndex: 1, auctionHistory: [] });
assert(networkContext.boardIndex === 1 && networkContext.showParDuringAuction === false &&
    networkContext.rendered === 1, 'goto-board distant laisse le PAR ouvert');

networkContext.showParDuringAuction = true;
networkContext.receiveBoardNetwork({ type: 'goto-board', boardIndex: 1, auctionHistory: [] });
assert(networkContext.showParDuringAuction === true, 'reception du meme goto-board ferme le PAR');

networkContext.receiveBoardNetwork({ type: 'goto-board', boardIndex: 999 });
assert(networkContext.boardIndex === 1 && networkContext.showParDuringAuction,
    'goto-board invalide modifie la vue');

networkContext.deferredRoomMode = true;
networkContext.receiveBoardNetwork({ type: 'goto-board', boardIndex: 0, auctionHistory: [] });
assert(networkContext.boardIndex === 1 && networkContext.showParDuringAuction,
    'goto-board en differe modifie une vue locale');

networkContext.receiveBoardNetwork({
    type: 'resync', deals: [{ board: 1, auctionHistory: [] }, { board: 2, auctionHistory: [] }],
    boardIndex: 0, yourSeats: [], botSeats: [], deferredRoomMode: true
});
assert(networkContext.boardIndex === 1 && networkContext.showParDuringAuction,
    'resync differe deplace la donne ou ferme un PAR manuel');

networkContext.receiveBoardNetwork({
    type: 'resync', deals: [{ board: 1, auctionHistory: [] }, { board: 2, auctionHistory: [] }],
    boardIndex: 0, yourSeats: [], botSeats: [], deferredRoomMode: false
});
assert(networkContext.boardIndex === 0 && networkContext.showParDuringAuction === false,
    'resync live ne remet pas les encheres lors du changement de donne');

networkContext.showParDuringAuction = true;
networkContext.receiveBoardNetwork({
    type: 'resync', deals: [{ board: 1, auctionHistory: [] }, { board: 2, auctionHistory: [] }],
    boardIndex: 0, yourSeats: [], botSeats: [], deferredRoomMode: false
});
assert(networkContext.showParDuringAuction === true, 'resync live de la meme donne ferme le PAR');

console.log('PLAY PAR manuel / 4 mains gate PASS');
