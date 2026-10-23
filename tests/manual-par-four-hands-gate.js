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

console.log('PLAY PAR manuel / 4 mains gate PASS');
