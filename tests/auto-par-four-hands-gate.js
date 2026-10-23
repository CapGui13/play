'use strict';
// PLAY : tests cib les sur PAR auto en vue 4 mains (sans moteur ni reseau).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'ui-events.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function extract(name) {
    const start = app.indexOf('function ' + name + '(');
    assert(start >= 0, name + ' absent');
    const open = app.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < app.length; i++) {
        if (app[i] === '{') depth++;
        if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
    }
    throw new Error('fonction tronquee : ' + name);
}

assert(html.includes('id="autoParFourHandsBtn"') &&
    html.includes('data-ui-click="toggle-auto-par-four-hands"'), 'bouton PAR auto absent');
assert(ui.includes("case 'toggle-auto-par-four-hands': return call('uiToggleAutoParFourHands');"), 'handler UI absent');
assert(app.includes("loadBoolPref('bridgeBidAutoParFourHands', false)"), 'option locale non persistante');
assert(app.includes("autoParBtn.setAttribute('aria-pressed'"), 'etat du bouton non accessible');
assert(app.includes('syncAutoParForCurrentDeal(deal, showAllHandsEarly, canViewParDuringAuction, ddTableHtml);'),
    'PAR auto non connecte au rendu de chaque donne');
assert(app.includes('if (idx === boardIndex && (isAuctionOver(auctionHistory) || isTrueOriginalHost() || isKibbitz())) checkAuctionEnd();'),
    'arrivee tardive DD ne rafraichit plus la donne courante');

const board1 = { board: 1, ddTable: { ready: true }, statisticalParMode: true };
const board2 = { board: 2, ddTable: { ready: true }, statisticalParMode: true };
const c = {
    autoParWithFourHands: true,
    hostSeeAllHands: true,
    autoParOpenedDeal: null,
    autoParDismissedDeal: null,
    showParDuringAuction: false,
    current: board1,
    deals: [board1, board2],
    auctionHistory: [],
    isTrueOriginalHost: () => true,
    isKibbitz: () => false,
    isAuctionOver: () => false,
    currentDeal() { return c.current; },
    renderBiddingBox() {},
    checkAuctionEnd() {},
    renderHandDisplayOptionButtons() {},
    saveBoolPref(k, v) { c.saved = [k, v]; }
};
vm.createContext(c);
vm.runInContext([
    'isFourHandsModeLocallyActive',
    'canViewExactParDuringAuction',
    'syncAutoParForCurrentDeal',
    'uiToggleParBiddingView',
    'uiToggleAutoParFourHands'
].map(extract).join('\n'), c);

// Les chances statistiques empechent toujours le PAR en l'absence de choix explicite.
assert(c.canViewExactParDuringAuction(board1, false) === false, 'PAR statistique divulgue sans vue 4 mains');
assert(c.canViewExactParDuringAuction(board1, true) === true, 'PAR auto refuse malgre option explicite');
c.autoParWithFourHands = false;
assert(c.canViewExactParDuringAuction(board1, true) === false, 'PAR statistique divulgue sans option');
c.autoParWithFourHands = true;

// Tant que DD n'est pas calcule, laisser l'enchere visible.
c.syncAutoParForCurrentDeal(board1, true, true, '');
assert(c.showParDuringAuction === false, 'ouverture du PAR avant le calcul');

// DD arrive : bascule automatique exactement sur la donne active.
c.syncAutoParForCurrentDeal(board1, true, true, '<table>DD1</table>');
assert(c.showParDuringAuction === true && c.autoParOpenedDeal === board1, 'PAR auto non ouvert a reception DD');

// Retour manuel aux encheres = veto local, sans reouverture au rendu suivant.
c.uiToggleParBiddingView();
assert(c.showParDuringAuction === false && c.autoParDismissedDeal === board1, 'retour manuel non respecte');
c.syncAutoParForCurrentDeal(board1, true, true, '<table>DD1</table>');
assert(c.showParDuringAuction === false, 'PAR se rouvre contre le choix manuel');

// Nouveau board : aucune inhibition par le veto sur la precedente donne.
c.current = board2;
c.syncAutoParForCurrentDeal(board2, true, true, '<table>DD2</table>');
assert(c.showParDuringAuction === true && c.autoParOpenedDeal === board2, 'PAR non ouvert sur la nouvelle donne');

// Fermer le mode 4 mains desactive seulement une vue auto.
c.syncAutoParForCurrentDeal(board2, false, false, '');
assert(c.showParDuringAuction === false && c.autoParOpenedDeal === null, 'PAR reste visible apres fermeture 4 mains');

// Desactiver l'option restaure les encheres et enregistre la preference.
c.syncAutoParForCurrentDeal(board2, true, true, '<table>DD2</table>');
assert(c.showParDuringAuction, 'test precondition auto mode');
c.uiToggleAutoParFourHands();
assert(c.autoParWithFourHands === false && c.showParDuringAuction === false, 'desactivation PAR auto non respectee');
assert(c.saved[0] === 'bridgeBidAutoParFourHands' && c.saved[1] === false, 'preference non memorisee');

// Sans PAR auto, le PAR manuel reste accessible hors du mode statistique.
board2.statisticalParMode = false;
c.uiToggleParBiddingView();
assert(c.showParDuringAuction === true, 'PAR manuel non accessible quand auto desactive');
c.uiToggleAutoParFourHands(); // reactiver option ne doit pas casser la selection manuelle
assert(c.showParDuringAuction === true, 'activation de PAR auto ferme un PAR manuel');

// Rendu mobile : la barre existante scrolle horizontalement avec scrollbar
// cachee. Le controle mobile doit donc exister hors de cette barre et etre
// synchronise avec le bouton desktop et les memes autorisations.
assert(html.includes('id="autoParFourHandsMobileRow"') &&
    html.includes('id="autoParFourHandsMobileBtn"'), 'controle mobile manquant');
assert(html.indexOf('id="autoParFourHandsMobileRow"') > html.indexOf('class="hand-display-options"') &&
    html.indexOf('id="autoParFourHandsMobileRow"') < html.indexOf('class="game-content-row"'),
    'controle mobile non place entre options et mains');
assert(css.includes('.hand-display-options #autoParFourHandsBtn') &&
    css.includes('display: none !important;') &&
    css.includes('.auto-par-mobile-row.has-auto-par-option'),
    'CSS mobile PAR auto non protege contre scroll horizontal');

const makeElement = () => ({
    style: { display: 'none' },
    classList: {
        states: new Map(),
        toggle(key, value) { this.states.set(key, value); }
    },
    attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; }
});
const desktopOption = makeElement();
const mobileOption = makeElement();
const mobileRow = makeElement();
const elements = {
    autoParFourHandsBtn: desktopOption,
    autoParFourHandsMobileBtn: mobileOption,
    autoParFourHandsMobileRow: mobileRow
};
c.document = { getElementById: id => elements[id] || null };
c.useFrenchRanks = false;
c.showHcp = false;
c.showKr = false;
c.showHandStrip = false;
c.showLedgerNames = false;
vm.runInContext(extract('renderHandDisplayOptionButtons'), c);
c.renderHandDisplayOptionButtons();
for (const btn of [desktopOption, mobileOption]) {
    assert(btn.style.display === '', 'PAR auto non affiche avec 4 mains actives');
    assert(btn.attrs['aria-pressed'] === 'true', 'etat PAR auto non synchronise');
}
assert(mobileRow.classList.states.get('has-auto-par-option'), 'ligne PAR auto mobile non revelee');
c.hostSeeAllHands = false;
c.renderHandDisplayOptionButtons();
for (const btn of [desktopOption, mobileOption]) {
    assert(btn.style.display === 'none', 'PAR auto visible sans mode 4 mains');
}
assert(!mobileRow.classList.states.get('has-auto-par-option'), 'ligne mobile visible sans 4 mains');

console.log('PLAY PAR auto / 4 mains gate PASS');
