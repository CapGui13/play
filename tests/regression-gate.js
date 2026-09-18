'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const appPath = path.join(ROOT, 'app.js');
const swPath = path.join(ROOT, 'sw.js');
const peerPath = path.join(ROOT, 'peer-connection.js');

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) fail(`Fonction introuvable: ${name}`);
    const bodyStart = source.indexOf('{', start);
    if (bodyStart < 0) fail(`Corps introuvable: ${name}`);
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = bodyStart; i < source.length; i++) {
        const c = source[i];
        const n = source[i + 1];
        if (lineComment) {
            if (c === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (c === '*' && n === '/') { blockComment = false; i++; }
            continue;
        }
        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && n === '/') { lineComment = true; i++; continue; }
        if (c === '/' && n === '*') { blockComment = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    fail(`Fin de fonction introuvable: ${name}`);
}

// R143.2 — compilateur de test résilient : embarque récursivement les helpers d'app.js
// appelés par la fonction testée, ainsi que les constantes scalaires simples. Cela permet
// d'exécuter cette gate directement en CI sans qu'un refactor interne casse artificiellement
// le vm de test faute d'un helper ajouté manuellement au contexte.
function compileFunction(source, name, context = {}) {
    const sandbox = { ...context };
    const seenFunctions = new Set();
    const functionChunks = [];
    const scalarChunks = [];
    const seenScalars = new Set();

    function maybeCollectScalar(identifier) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(identifier)) return;
        if (Object.prototype.hasOwnProperty.call(sandbox, identifier) || seenScalars.has(identifier)) return;
        const re = new RegExp('(?:^|\\n)\\s*const\\s+' + identifier + '\\s*=\\s*([^;\\n]+)\\s*;', 'm');
        const match = source.match(re);
        if (!match) return;
        const expression = String(match[1] || '').trim();
        if (!/^(?:-?\d+(?:\.\d+)?|true|false|null|undefined|'[^'\n]*'|"[^"\n]*")$/.test(expression)) return;
        seenScalars.add(identifier);
        scalarChunks.push('const ' + identifier + ' = ' + expression + ';');
    }

    function collect(functionName) {
        if (seenFunctions.has(functionName) || Object.prototype.hasOwnProperty.call(sandbox, functionName)) return;
        const marker = 'function ' + functionName + '(';
        if (!source.includes(marker)) return;
        seenFunctions.add(functionName);
        const text = extractFunction(source, functionName);
        const identifiers = text.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || [];
        for (const identifier of identifiers) maybeCollectScalar(identifier);
        const callRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
        let match;
        while ((match = callRe.exec(text))) {
            const dependency = match[1];
            if (dependency !== functionName && source.includes('function ' + dependency + '(')) collect(dependency);
        }
        functionChunks.push(text);
    }

    collect(name);
    if (!seenFunctions.has(name) && !Object.prototype.hasOwnProperty.call(sandbox, name)) fail('Fonction introuvable: ' + name);
    const program = scalarChunks.join('\n') + '\n' + functionChunks.join('\n') + '\n' + name + ';';
    return vm.runInNewContext(program, sandbox);
}
function extractSetValues(source, name) {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)\\s*;`);
    const m = source.match(re);
    if (!m) fail(`Set introuvable: ${name}`);
    return Array.from(m[1].matchAll(/'([^']+)'/g), x => x[1]);
}

const app = read(appPath);
const sw = read(swPath);
const peer = read(peerPath);

// ---------------------------------------------------------------------------
// 1) R123 + R125 : population complète et stable 24 -> 48 -> 72
// ---------------------------------------------------------------------------
function adaptiveCandidateContext(matchFn) {
    return {
        CONTRACT_CHANCE_TARGET: 24,
        CONTRACT_CHANCE_ADAPTIVE_MAX_TARGET: 72,
        CONTRACT_CHANCE_MAX_ATTEMPTS: 2160,
        contractChanceCandidatePlanCache: new WeakMap(),
        contractChanceConfigForSide: () => ({ ok: true, randomizedSeats: ['E', 'W'] }),
        statisticalParPublicConditioning: () => ({ informative: true, constraints: {} }),
        statisticalParAuctionSignature: () => 'sig',
        window: {
            PlayStatisticalPar: {
                sampleHandsDeterministic: (_deal, _config, sampleIndex) => ({ sampleIndex }),
                profilesForSeats: hands => ({ sampleIndex: hands.sampleIndex }),
                profilesMatchPublicConstraints: matchFn
            }
        }
    };
}

const adaptiveDeal = { hands: { N: {}, S: {}, E: {}, W: {} } };
// 72 conditionnés possibles : le préfixe 24 doit être exactement le même quand on
// élargit ensuite à 48 puis 72.
{
    const ctx = adaptiveCandidateContext(profiles => profiles.sampleIndex % 2 === 0);
    const fn = compileFunction(app, 'contractChanceBuildCandidates', ctx);
    const p24 = fn(adaptiveDeal, 'NS', true, 24);
    const p48 = fn(adaptiveDeal, 'NS', true, 48);
    const p72 = fn(adaptiveDeal, 'NS', true, 72);
    assert(p24.length === 24 && p48.length === 48 && p72.length === 72, 'R125: tailles adaptatives incorrectes');
    assert(p24.every((row, i) => row.sampleIndex === i * 2), 'R125: conditionnement 24 incorrect');
    assert(p24.every((row, i) => row.sampleIndex === p48[i].sampleIndex && row.sampleIndex === p72[i].sampleIndex), 'R125: population change entre 24/48/72');
}

// Moins de 72 conditionnés complets => tout le plan doit retomber au brut, même si 24
// conditionnés auraient été disponibles. Cela empêche un changement de population à 48.
{
    const deal = { hands: { N: {}, S: {}, E: {}, W: {} } };
    const ctx = adaptiveCandidateContext(profiles => profiles.sampleIndex < 60);
    const fn = compileFunction(app, 'contractChanceBuildCandidates', ctx);
    const p24 = fn(deal, 'NS', true, 24);
    const p72 = fn(deal, 'NS', true, 72);
    assert(p24.every((row, i) => row.sampleIndex === i), 'R125: fallback brut 24 incorrect si seulement 60/72 conditionnés');
    assert(p72.every((row, i) => row.sampleIndex === i), 'R125: fallback brut 72 incorrect');
}

// Pendant l'enchère, aucun raffinement : exactement les 24 bruts historiques.
{
    const deal = { hands: { N: {}, S: {}, E: {}, W: {} } };
    const ctx = adaptiveCandidateContext(() => true);
    const fn = compileFunction(app, 'contractChanceBuildCandidates', ctx);
    const raw = fn(deal, 'NS', false, 24);
    assert(raw.length === 24 && raw.every((row, i) => row.sampleIndex === i), 'Pré-chauffage brut différent de 24');
}

// Décision adaptative : un 75 % sur 24 tirages doit être raffiné ; un 0/100 % très net
// ne doit pas déclencher 48 DDS supplémentaires. A 48, un 75 % reste assez incertain pour 72.
const wilson = compileFunction(app, 'contractChanceWilsonMargin95');
const needsRefine = compileFunction(app, 'contractChanceNeedsAdaptiveRefinement', {
    CONTRACT_CHANCE_TARGET: 24,
    CONTRACT_CHANCE_ADAPTIVE_MAX_TARGET: 72,
    CONTRACT_CHANCE_ADAPTIVE_MARGIN_AFTER_24: 0.13,
    CONTRACT_CHANCE_ADAPTIVE_MARGIN_AFTER_48: 0.10,
    contractChanceWilsonMargin95: wilson
});
assert(needsRefine(18, 24, 24), 'R125: 75% sur 24 devrait passer à 48');
assert(needsRefine(12, 24, 24), 'R125: 50% sur 24 devrait passer à 48');
assert(!needsRefine(24, 24, 24), 'R125: 100% sur 24 ne devrait pas être raffiné');
assert(!needsRefine(0, 24, 24), 'R125: 0% sur 24 ne devrait pas être raffiné');
assert(needsRefine(36, 48, 48), 'R125: 75% sur 48 devrait passer à 72');
assert(!needsRefine(48, 48, 48), 'R125: 100% sur 48 ne devrait pas passer à 72');
assert(!needsRefine(54, 72, 72), 'R125: 72 est le plafond absolu');

// Transition complète d'un camp : 24 -> 48 -> 72 ; l'autre camp très net s'arrête à 24.
{
    const state = {
        generation: 7,
        sides: {
            NS: { adaptiveTarget: 24, adaptiveSettled: false },
            EW: { adaptiveTarget: 24, adaptiveSettled: false }
        }
    };
    const available = { NS: 24, EW: 24 };
    const won = { NS: 18, EW: 24 };
    const update = compileFunction(app, 'contractChanceUpdateAdaptiveTargets', {
        isAuctionOver: () => true,
        determineContract: () => ({ declarer: 'N' }),
        contractChanceDealState: () => state,
        contractChanceGeneration: 7,
        contractChanceOrderedSides: (_deal, sides) => Array.isArray(sides) ? sides : ['NS', 'EW'],
        contractChanceTargetsForDeal: () => [
            { side: 'NS', isReferenceOnly: false },
            { side: 'EW', isReferenceOnly: false }
        ],
        contractChanceSideGoal: (_deal, side) => state.sides[side].adaptiveTarget,
        contractChanceSelectedEntries: (_deal, side, goal) => Array.from({ length: Math.min(available[side], goal) }, () => ({})),
        contractChanceComputeTargetStats: (_deal, _contract, target, rows) => ({ successes: won[target.side], samples: rows.length }),
        contractChanceNeedsAdaptiveRefinement: needsRefine,
        CONTRACT_CHANCE_TARGET: 24,
        CONTRACT_CHANCE_ADAPTIVE_MID_TARGET: 48,
        CONTRACT_CHANCE_ADAPTIVE_MAX_TARGET: 72
    });
    const deal = { ddTable: {}, auctionHistory: [] };
    assert(update(deal), 'R125: transition 24->48 non déclenchée');
    assert(state.sides.NS.adaptiveTarget === 48, 'R125: NS devrait viser 48');
    assert(state.sides.EW.adaptiveSettled, 'R125: EW 100% devrait être stabilisé à 24');
    available.NS = 48; won.NS = 36;
    assert(update(deal) && state.sides.NS.adaptiveTarget === 72, 'R125: transition 48->72 non déclenchée');
    available.NS = 72; won.NS = 54;
    assert(!update(deal) && state.sides.NS.adaptiveSettled, 'R125: 72 doit clôturer le raffinement');
}

// ---------------------------------------------------------------------------
// 2) R120 : ne pas afficher une montée de même couleur sans nouveau palier de prime
// ---------------------------------------------------------------------------
const bonusMilestone = compileFunction(app, 'contractChanceBonusMilestone', {
    STRAIN_ORDER: ['N', 'S', 'H', 'D', 'C']
});
const sameStrainUseful = compileFunction(app, 'contractChanceSameStrainUpgradeIsUseful', {
    contractChanceBonusMilestone: bonusMilestone
});
const T = (side, level, strain) => ({ side, level, strain });
assert(!sameStrainUseful(T('NS', 1, 'N'), T('NS', 2, 'N')), 'R120: 1SA→2SA doit être masqué');
assert(sameStrainUseful(T('NS', 2, 'N'), T('NS', 3, 'N')), 'R120: 2SA→3SA doit rester');
assert(!sameStrainUseful(T('NS', 4, 'S'), T('NS', 5, 'S')), 'R120: 4P→5P doit être masqué');
assert(sameStrainUseful(T('NS', 5, 'S'), T('NS', 6, 'S')), 'R120: 5P→6P doit rester');
assert(sameStrainUseful(T('NS', 6, 'S'), T('NS', 7, 'S')), 'R120: 6P→7P doit rester');
assert(sameStrainUseful(T('NS', 4, 'S'), T('EW', 4, 'S')), 'R120: autre camp ne doit pas être filtré');

// ---------------------------------------------------------------------------
// 3) R122 : déclarants séparés, déclarant établi affiché en premier, pas de moyenne
// ---------------------------------------------------------------------------
const parseBid = call => {
    const m = String(call || '').match(/^([1-7])(NT|C|D|H|S)$/);
    return m ? { level: Number(m[1]), strain: m[2] } : null;
};
const sideFromDeclarer = d => (d === 'N' || d === 'S' || d === 'NS') ? 'NS' : ((d === 'E' || d === 'W' || d === 'EW') ? 'EW' : '');
const bidCanEstablishDeclarer = compileFunction(app, 'contractChanceAuctionBidCanEstablishDeclarer');
const auctionEstablishedDeclarer = compileFunction(app, 'contractChanceAuctionEstablishedDeclarer', {
    parseBid,
    contractChanceAuctionBidCanEstablishDeclarer: bidCanEstablishDeclarer
});
const established = compileFunction(app, 'contractChanceEstablishedDeclarerForStrain', {
    parseBid,
    statisticalParSideFromDeclarer: sideFromDeclarer,
    contractChanceAuctionEstablishedDeclarer: auctionEstablishedDeclarer
});
assert(established({ auctionHistory: [{ seat: 'N', call: '1NT' }, { seat: 'E', call: 'PASS' }, { seat: 'S', call: '6NT' }] }, { declarer: 'N', strain: 'NT' }, 'NS', 'N') === 'N', 'R122: déclarant SA établi incorrect');

// R143.2 : un contrôle ne peut plus établir le déclarant statistique.
const controlDeal = {
    hands: {
        E: { S: 'AQJ973', H: '', D: 'A85', C: 'AQ76' },
        W: { S: 'K65', H: 'Q65', D: 'KQJ', C: 'JT52' }
    },
    auctionHistory: [
        { seat: 'W', call: '4D', explanation: 'Contrôle Carreau' },
        { seat: 'E', call: '4H', explanation: 'Contrôle Cœur' },
        { seat: 'W', call: '4S' },
        { seat: 'E', call: '6S' }
    ]
};
assert(auctionEstablishedDeclarer(controlDeal, 'EW', 'D') === '', 'R143.2: un contrôle 4K a établi le déclarant');
assert(auctionEstablishedDeclarer(controlDeal, 'EW', 'H') === '', 'R143.2: un contrôle 4C a établi le déclarant');
assert(auctionEstablishedDeclarer(controlDeal, 'EW', 'S') === 'E', 'R143.2: le contrôle 4P avec 3 cartes a masqué le vrai déclarant 6P');

const naturalDeal = {
    hands: { N: { H: 'AKJ87' }, S: { H: 'Q654' } },
    auctionHistory: [{ seat: 'N', call: '1H' }, { seat: 'S', call: '4H' }]
};
assert(auctionEstablishedDeclarer(naturalDeal, 'NS', 'H') === 'N', 'R143.2: une enchère naturelle 1C n’établit plus le déclarant');

const fastDeclarer = compileFunction(app, 'contractChanceFastPrimaryDeclarer', {
    contractChanceAuctionEstablishedDeclarer: auctionEstablishedDeclarer
});
assert(fastDeclarer({ ...controlDeal, ddTable: { S: { E: 12, W: 10 } } }, { side: 'EW', strain: 'S', declarer: 'EW' }, true) === 'E', 'R143.2: le préchauffage n’utilise pas le vrai déclarant naturel');
const controlOnlyDeal = {
    hands: { E: { S: 'AQJ973' }, W: { S: 'K65' } },
    auctionHistory: [{ seat: 'W', call: '4S', explanation: 'Contrôle Pique' }],
    ddTable: { S: { E: 12, W: 10 } }
};
assert(fastDeclarer(controlOnlyDeal, { side: 'EW', strain: 'S', declarer: 'EW' }, true) === '', 'R143.2: un simple contrôle déclenche encore le préchauffage');

const progressMap = new Map([['N', '75%'], ['S', '100%']]);
const groupHtml = compileFunction(app, 'contractChanceSidecarSideGroupHtml', {
    CONTRACT_CHANCE_TARGET: 24,
    CONTRACT_CHANCE_DECLARER_GAP_POINTS: 10,
    contractChanceEstablishedDeclarerForStrain: established,
    contractChanceTargetProgress: (_deal, _contract, target) => ({ text: progressMap.get(target.declarer), done: true, n: 24, goal: 24, successPct: Number(String(progressMap.get(target.declarer)).replace('%', '')) }),
    contractChanceRoundedPctText: progress => `${Number(progress && progress.successPct || 0).toFixed(0)}%`,
    contractChanceProgressCountText: progress => `${Number(progress && progress.n || 0)}/${Number(progress && progress.goal || 24)}`,
    contractChanceSidecarTargetHtml: (_deal, _contract, target, opts) => opts && opts.declarer ? `${opts.declarer} ${progressMap.get(target.declarer)}` : progressMap.get(target.declarer)
});
const splitTargets = [
    { side: 'NS', rowStrain: 'N', strain: 'N', level: 6, declarer: 'S' },
    { side: 'NS', rowStrain: 'N', strain: 'N', level: 6, declarer: 'N' }
];
const split = groupHtml({ auctionHistory: [{ seat: 'N', call: '1NT' }] }, { declarer: 'N', strain: 'NT' }, splitTargets);
assert(split.includes('N 75%') && split.includes('S 100%'), 'R122: différentiel N/S absent');
assert(split.indexOf('N 75%') < split.indexOf('S 100%'), 'R122: déclarant établi pas affiché en premier');
assert(!split.includes('88%'), 'R122: moyenne N/S réintroduite');

progressMap.set('N', '100%');
const compact = groupHtml({ auctionHistory: [{ seat: 'N', call: '1NT' }] }, { declarer: 'N', strain: 'NT' }, splitTargets);
assert(compact === '100%', 'R122: deux probabilités identiques doivent rester compactes');

// R143 : seuil déclarant = 10 points, et un sacrifice ne doit jamais créer un 3e pourcentage.
progressMap.set('N', '91%');
progressMap.set('S', '100%');
const gap9 = groupHtml({ auctionHistory: [{ seat: 'N', call: '1NT' }] }, { declarer: 'N', strain: 'NT' }, splitTargets);
assert(gap9 === '91%', 'R143: écart de 9 points devrait rester compact');

progressMap.set('N', '90%');
const gap10 = groupHtml({ auctionHistory: [{ seat: 'N', call: '1NT' }] }, { declarer: 'N', strain: 'NT' }, splitTargets);
assert(gap10.includes('N 90%') && gap10.includes('S 100%'), 'R143: écart de 10 points devrait afficher les deux déclarants');

const withSacrifice = splitTargets.concat({
    kind: 'sacrifice', side: 'NS', rowStrain: 'N', strain: 'N', level: 7, declarer: 'N', doubled: 'X'
});
const gap10WithSacrifice = groupHtml({ auctionHistory: [{ seat: 'N', call: '1NT' }] }, { declarer: 'N', strain: 'NT' }, withSacrifice);
assert(gap10WithSacrifice === gap10, 'R143: un sacrifice ne doit ni être affiché ni casser la comparaison N/S');

// R143 : la sélection statistique ne dépend plus d'une couleur annoncée et exclut les sacrifices.
const relevantTargetsText = extractFunction(app, 'relevantContractChanceSidecarTargets');
assert(!relevantTargetsText.includes('announced.has'), 'R143: une couleur annoncée conditionne encore une partielle PAR');
assert(!relevantTargetsText.includes('optimalContractTargetsForDeal(deal)'), 'R143: le sidecar réinjecte encore des sacrifices');

const targetKey = target => [target.kind || 'make', target.level, target.strain, target.declarer || '', target.doubled || '', target.side || ''].join(':');
const targetsForDeal = compileFunction(app, 'contractChanceTargetsForDeal', {
    relevantContractChanceSidecarTargets: () => [
        { kind: 'make', side: 'NS', level: 2, strain: 'H', declarer: 'N' },
        { kind: 'sacrifice', side: 'NS', level: 7, strain: 'H', declarer: 'N', doubled: 'X' }
    ],
    optimalContractTargetKey: targetKey,
    playedContractChanceTarget: () => null
});
const statisticalTargets = targetsForDeal({}, {});
assert(statisticalTargets.length === 1 && statisticalTargets[0].kind === 'make', 'R143: sacrifice encore présent dans les cibles statistiques');

const computeTargetStats = compileFunction(app, 'contractChanceComputeTargetStats', {
    optimalContractTricks: (_table, target) => Number(target.mockTricks || 0)
});
const leakedSac = computeTargetStats({}, {}, { kind: 'sacrifice', level: 7, mockTricks: 8 }, [{}, {}], []);
assert(leakedSac.samples === 0 && leakedSac.successes === 0, 'R143: rentabilité de sacrifice encore calculable');

// R143 : un contrat contré qui gagne reste un contrat à réaliser, pas un sacrifice.
const exactParTargets = compileFunction(app, 'contractChanceExactParTargets', {
    actualDealParFromKnownDeal: () => ({ contracts: [
        { level: 2, strain: 'H', declarer: 'N', doubled: 'X', mockTricks: 8 },
        { level: 3, strain: 'H', declarer: 'S', doubled: 'X', mockTricks: 8 }
    ] }),
    statisticalParSideFromDeclarer: sideFromDeclarer,
    optimalContractTricks: (_table, target) => Number(target.mockTricks),
    contractChanceTierForContract: () => 'partial',
    STRAIN_ORDER: ['N', 'S', 'H', 'D', 'C']
});
const doubledTargets = exactParTargets({ ddTable: {} });
assert(doubledTargets[0].kind === 'make', 'R143: contrat contré gagnant classé à tort comme sacrifice');
assert(doubledTargets[1].kind === 'sacrifice', 'R143: contrat contré chuté non reconnu comme sacrifice');

// R143 : même si DealerPar contient un sacrifice plus "haut", la cible primaire statistique est un contrat gagnant.
const primaryParTarget = compileFunction(app, 'contractChancePrimaryParTarget', {
    contractChanceExactParTargets: () => [
        { kind: 'sacrifice', side: 'NS', tier: 'sacrifice', level: 7, strain: 'H' },
        { kind: 'make', side: 'EW', tier: 'partial', level: 2, strain: 'S' }
    ],
    contractChanceLogicalTargetRank: (_deal, target) => target.kind === 'sacrifice' ? 9999 : 1
});
const primaryMake = primaryParTarget({ ddTable: {} });
assert(primaryMake && primaryMake.kind === 'make', 'R143: un sacrifice reste prioritaire dans le préchauffage statistique');

// R143.2 : si DealerPar ne contient qu’un sacrifice, préchauffer le GROS contrat adverse,
// pas la partielle du camp sacrifiant même si son fit obtient un meilleur rang logique.
const sacrificeFallbackPrimary = compileFunction(app, 'contractChancePrimaryParTarget', {
    contractChanceExactParTargets: () => [
        { kind: 'sacrifice', side: 'NS', tier: 'sacrifice', level: 7, strain: 'H' }
    ],
    ddTableChanceTargetsForDeal: () => [
        { kind: 'make', side: 'NS', tier: 'partial', level: 2, strain: 'H', isBestTableTarget: true },
        { kind: 'make', side: 'EW', tier: 'slam', level: 6, strain: 'S', isBestTableTarget: true }
    ],
    contractChanceLogicalTargetRank: (_deal, target) => target.side === 'NS' ? 510 : 509
});
const fallbackBigContract = sacrificeFallbackPrimary({ ddTable: {} });
assert(fallbackBigContract && fallbackBigContract.side === 'EW' && fallbackBigContract.tier === 'slam' && fallbackBigContract.level === 6,
    'R143.2: une partielle sacrificielle est encore préchauffée avant le chelem adverse');

// ---------------------------------------------------------------------------
// 4) Frontière d'autorité réseau : un invité ne peut pas envoyer des commandes hôte
// ---------------------------------------------------------------------------
const guestTypes = new Set(extractSetValues(app, 'PEER_TYPES_FROM_GUEST'));
const hostTypes = new Set(extractSetValues(app, 'PEER_TYPES_FROM_HOST'));
for (const forbidden of ['lobby-state', 'start-game', 'goto-board', 'reset-auction', 'undo-apply', 'resync']) {
    assert(!guestTypes.has(forbidden), `Sécurité protocole: ${forbidden} autorisé depuis un invité`);
}
assert(guestTypes.has('contract-chance-work-result'), 'Collaboration: résultat invité non autorisé');
assert(hostTypes.has('contract-chance-work'), 'Collaboration: job hôte non autorisé');
assert(hostTypes.has('contract-chance-result'), 'Synchronisation statistique: snapshot hôte non autorisé');

// Double garde de confidentialité : ni l'hôte ni l'invité ne doivent distribuer/résoudre
// un job collaboratif avant la fin de l'enchère.
const dispatchText = extractFunction(app, 'contractChanceDispatchCollaborativeWork');
const solveText = extractFunction(app, 'contractChanceSolveGuestWork');
assert(/isAuctionOver\s*\(/.test(dispatchText), 'Confidentialité: garde fin enchère absente côté hôte');
assert(/isAuctionOver\s*\(/.test(solveText), 'Confidentialité: garde fin enchère absente côté invité');

// R125 : le snapshot reste version 1 pour compatibilité, mais transporte les champs
// adaptatifs optionnels. Les anciens clients continuent de lire `n <= 24`.
const snapshotText = extractFunction(app, 'contractChanceBuildSnapshot');
assert(/adaptiveN:\s*progress\.n/.test(snapshotText), 'R125: adaptiveN absent du snapshot');
assert(/goal:\s*progress\.goal/.test(snapshotText), 'R125: goal adaptatif absent du snapshot');
assert(/Math\.min\(CONTRACT_CHANCE_TARGET,\s*progress\.n\)/.test(snapshotText), 'R125: compatibilité n<=24 absente');
const snapshotProgress = compileFunction(app, 'contractChanceSnapshotProgress', {
    CONTRACT_CHANCE_TARGET: 24,
    CONTRACT_CHANCE_ADAPTIVE_MAX_TARGET: 72,
    statisticalParAuctionSignature: () => 'sig',
    optimalContractTargetKey: () => 'k'
});
const remoteAdaptive = snapshotProgress({
    auctionHistory: [],
    statisticalChanceSnapshot: { version: 1, auctionSignature: 'sig', values: { k: { n: 24, adaptiveN: 36, goal: 48, done: false, successPct: 75 } } }
}, {});
assert(remoteAdaptive.n === 36 && remoteAdaptive.goal === 48 && remoteAdaptive.text === '75% · 36/48', 'R125: progression adaptative distante incorrecte');

// ---------------------------------------------------------------------------
// 5) R126 : protocole réseau versionné sans casser les clients legacy
// ---------------------------------------------------------------------------
const localProtocol = compileFunction(app, 'localPlayProtocolInfo', {
    PLAY_PROTOCOL_VERSION: 1,
    PLAY_PROTOCOL_MIN_COMPATIBLE: 0,
    PLAY_PROTOCOL_CAPABILITIES: Object.freeze([
        'network-authority-v1', 'cloud-session-v1', 'contract-chance-sync-v1',
        'contract-chance-collab-v1', 'contract-chance-adaptive-v1',
        'contract-chance-declarer-split-v1'
    ])
});
const normalizeProtocol = compileFunction(app, 'normalizePlayProtocolInfo');
const protocolsCompatible = compileFunction(app, 'arePlayProtocolsCompatible', {
    normalizePlayProtocolInfo: normalizeProtocol
});
const allowsProtocolCapability = compileFunction(app, 'playProtocolAllowsCapability', {
    normalizePlayProtocolInfo: normalizeProtocol
});
const lp = localProtocol();
assert(lp.version === 1 && lp.minCompatibleVersion === 0, 'R126: version locale du protocole incorrecte');
assert(lp.capabilities.includes('contract-chance-collab-v1'), 'R126: capacité collaborative non publiée');
const legacyProtocol = normalizeProtocol(undefined);
assert(legacyProtocol.version === 0 && legacyProtocol.legacy && legacyProtocol.valid, 'R126: client pré-R126 non reconnu comme legacy');
assert(protocolsCompatible(lp, legacyProtocol), 'R126: R126 ne doit pas casser un client legacy compatible');
assert(protocolsCompatible(lp, { version: 1, minCompatibleVersion: 0, capabilities: [] }), 'R126: protocole v1 compatible rejeté');
assert(!protocolsCompatible(lp, { version: 2, minCompatibleVersion: 2, capabilities: [] }), 'R126: client futur exigeant v2 devrait être rejeté');
assert(!protocolsCompatible(lp, { version: 1, minCompatibleVersion: 2, capabilities: [] }), 'R126: déclaration de protocole invalide acceptée');
assert(allowsProtocolCapability(null, 'contract-chance-collab-v1', true), 'R126: compatibilité legacy de la collaboration cassée');
assert(!allowsProtocolCapability({ version: 1, minCompatibleVersion: 0, capabilities: [] }, 'contract-chance-collab-v1', true), 'R126: capacité absente ignorée sur pair versionné');
assert(allowsProtocolCapability({ version: 1, minCompatibleVersion: 0, capabilities: ['contract-chance-collab-v1'] }, 'contract-chance-collab-v1', true), 'R126: capacité déclarée non reconnue');

const guestMetadataText = extractFunction(app, 'guestConnectionMetadata');
assert(/protocol:\s*localPlayProtocolInfo\(\)/.test(guestMetadataText), 'R126: l’invité ne publie pas sa version dans les métadonnées PeerJS');
const hostHandlersText = extractFunction(app, 'buildHostHandlers');
assert(/protocol:\s*localPlayProtocolInfo\(\)/.test(hostHandlersText), 'R126: welcome hôte ne publie pas la version du protocole');
assert(/protocolCompatible:\s*false/.test(hostHandlersText), 'R126: rejet explicite des versions incompatibles absent côté hôte');
const handlePeerText = extractFunction(app, 'handlePeerData');
assert(/stopGuestForIncompatibleProtocol\(remoteProtocol\)/.test(handlePeerText), 'R126: rejet clair d’un hôte incompatible absent côté invité');
const dispatchProtocolText = extractFunction(app, 'contractChanceDispatchCollaborativeWork');
assert(dispatchProtocolText.includes("guestPlayProtocolAllowsCapability(x.participant.id, 'contract-chance-collab-v1', true)"), 'R126: travail collaboratif non protégé par la négociation de capacité');

// Aucun nouveau type de message n’est requis pour négocier : les champs sont transportés
// dans les métadonnées PeerJS et le `welcome` historique, ce qui conserve l’interop legacy.
assert(!guestTypes.has('protocol-version') && !hostTypes.has('protocol-version'), 'R126: nouveau type de handshake inutilement ajouté');

// ---------------------------------------------------------------------------
// 6) Service Worker : ne jamais mettre en cache API / PeerJS / Pusher
// ---------------------------------------------------------------------------
const neverCacheMatch = sw.match(/const\s+NEVER_CACHE_HOSTS\s*=\s*\[([^\]]+)\]/);
assert(neverCacheMatch, 'Service Worker: NEVER_CACHE_HOSTS introuvable');
const neverCacheHosts = Array.from(neverCacheMatch[1].matchAll(/'([^']+)'/g), x => x[1]);
for (const required of ['peerjs.com', 'vercel.app', 'pusher.com']) {
    assert(neverCacheHosts.includes(required), `Service Worker: ${required} n'est plus exclu du cache`);
}
const shouldNeverCache = compileFunction(sw, 'shouldNeverCache', { NEVER_CACHE_HOSTS: neverCacheHosts, URL });
assert(shouldNeverCache('https://api-gen-beta.vercel.app/api/session?code=1234'), 'SW: API Vercel pourrait être cachée');
assert(shouldNeverCache('https://play-dds-native.vercel.app/api/dds-a'), 'SW: DDS Vercel pourrait être caché');
assert(shouldNeverCache('https://0.peerjs.com/id'), 'SW: PeerJS pourrait être caché');
assert(shouldNeverCache('https://js.pusher.com/8.4.0/pusher.min.js'), 'SW: Pusher pourrait être caché');
assert(!shouldNeverCache('https://capgui13.github.io/play/app.js'), 'SW: assets PLAY classés à tort comme externes interdits');


// ---------------------------------------------------------------------------
// 7) R128 : TURN hybride — temporaire d'abord, fallback historique si le broker refuse/tombe
// ---------------------------------------------------------------------------
assert(peer.includes("const TURN_CREDENTIALS_ENDPOINT = 'https://api-gen-beta.vercel.app/api/turn-credentials'"), 'R128: endpoint TURN temporaire absent');
assert(peer.includes('async function ensureFreshIceConfig('), 'R128: rafraîchissement TURN temporaire absent');
assert(peer.includes('TURN_CREDENTIAL_REFRESH_SKEW_MS'), 'R128: marge de rafraîchissement TURN absente');
assert(peer.includes('temporaryTurnCacheUsable'), 'R128: cache mémoire TURN absent');
assert(peer.includes('LEGACY_TURN_FALLBACK_SERVERS'), 'R128: fallback TURN historique absent');
assert(peer.includes('turn:free.expressturn.com:3478'), 'R128: fallback ExpressTURN absent');
assert(peer.includes('turn:standard.relay.metered.ca:80'), 'R128: fallback Metered absent');
assert(peer.includes('function legacyTurnFallbackConfig()'), 'R128: constructeur fallback TURN absent');
assert(peer.includes('turn-credential-fallback-legacy'), 'R128: télémétrie fallback TURN absente');
assert(/return legacyTurnFallbackConfig\(\)/.test(extractFunction(peer, 'ensureFreshIceConfig')), 'R128: panne du broker doit reprendre les relais historiques');
assert(peer.includes('iceConfig = await ensureFreshIceConfig(nextRoomCode)'), 'R128: création hôte ne récupère pas de config ICE dynamique');
assert(/ensureFreshIceConfig\(this\.roomCode\)/.test(peer), 'R128: join/reconnexion invité ne récupère pas de config ICE dynamique');
assert(peer.includes('new Peer(id, { config: iceConfig, debug: 1 })'), 'R128: hôte n’utilise pas la config ICE dynamique');
assert(peer.includes('new Peer({ config: iceConfig, debug: 1 })'), 'R128: invité n’utilise pas la config ICE dynamique');
assert(!/const\s+ICE_CONFIG\s*=/.test(peer), 'R128: ancienne configuration ICE monolithique réintroduite');


// ---------------------------------------------------------------------------
// 8) R133 : DDS WebAssembly local — aucun calcul DDS Vercel
// ---------------------------------------------------------------------------
assert(/const\s+LOCAL_DDS_WORKER_URL\s*=\s*'dds\/local-dds-worker\.js'\s*;/.test(app), 'R133: Worker DDS local absent');
assert(/const\s+LOCAL_DDS_BROWSER_ENABLED\s*=\s*typeof Worker === 'function'\s*;/.test(app), 'R133: détection Worker DDS local absente');
assert(/const\s+LOCAL_DDS_MAX_DESKTOP_WORKERS\s*=\s*4\s*;/.test(app), 'R138: plafond desktop DDS local modifié');
assert(/const\s+CONTRACT_CHANCE_LOCAL_DDS_ENABLED\s*=\s*LOCAL_DDS_BROWSER_ENABLED\s*;/.test(app), 'R133: PAR statistique non relié au DDS local');
assert(/const\s+CONTRACT_CHANCE_REMOTE_DDS_ENABLED\s*=\s*false\s*;/.test(app), 'R133: DDS distant doit rester désactivé');
assert(/const\s+CONTRACT_CHANCE_NATIVE_URLS\s*=\s*\[\s*\]\s*;/.test(app), 'R133: anciennes lanes DDS distantes encore configurées');
assert(/const\s+CONTRACT_CHANCE_LEGACY_URL\s*=\s*''\s*;/.test(app), 'R133: fallback DDS distant encore configuré');

assert(!app.includes('play-dds-native.vercel.app/api/dds-'), 'R133: endpoint play-dds-native encore présent');
assert(!app.includes('api-gen-beta.vercel.app/api/dds'), 'R133: endpoint api-gen-beta DDS encore présent');

assert(/const\s+CONTRACT_CHANCE_TARGET\s*=\s*24\s*;/.test(app), 'R133: cible initiale 24 modifiée');
assert(/const\s+CONTRACT_CHANCE_ADAPTIVE_MID_TARGET\s*=\s*48\s*;/.test(app), 'R133: cible 48 modifiée');
assert(/const\s+CONTRACT_CHANCE_ADAPTIVE_MAX_TARGET\s*=\s*72\s*;/.test(app), 'R133: cible 72 modifiée');

const r133DesiredWorkers = extractFunction(app, 'localDdsDesiredWorkerCount');
assert(r133DesiredWorkers.includes('if (isLikelyMobileDevice()) return 1'), 'R133: mobile doit rester à un seul Worker DDS');
assert(r133DesiredWorkers.includes('return LOCAL_DDS_MAX_DESKTOP_WORKERS'), 'R138: pool DDS desktop adaptatif absent');

const r133Solve = extractFunction(app, 'contractChanceSolveBatch');
assert(r133Solve.includes('rows = await localDdsSolveItems(items, priority)'), 'R133: PAR statistique ne passe pas par DDS local');
assert(!r133Solve.includes('contractChanceFetchLane('), 'R133: contractChanceSolveBatch contient encore un appel DDS distant');

const r133Exact = extractFunction(app, 'sendDDChunk');
assert(r133Exact.includes('const table = await localDdsSolveOne(item.pbn, priority)'), 'R133: table DD exacte ne passe pas par DDS local');
assert(!r133Exact.includes('fetch('), 'R133: table DD exacte contient encore un fetch réseau');

const r133Fetch = extractFunction(app, 'contractChanceFetchLane');
assert(r133Fetch.includes('if (!CONTRACT_CHANCE_REMOTE_DDS_ENABLED) return []'), 'R133: coupe-circuit DDS distant absent');

const r133Render = extractFunction(app, 'renderInlineParChances');
assert(r133Render.includes('if (!CONTRACT_CHANCE_LOCAL_DDS_ENABLED) return'), 'R133: affichage PAR statistique non gardé par DDS local');

const r133Final = extractFunction(app, 'ensureContractChanceFinalCalculation');
assert(r133Final.includes('if (!CONTRACT_CHANCE_LOCAL_DDS_ENABLED) return'), 'R133: calcul final PAR statistique non gardé par DDS local');


// R138 — ordonnanceur PAR-first + coopération locale.
assert(app.includes('function contractChancePrimaryParTarget('), 'R138: sélection PAR principal absente');
assert(app.includes('function contractChanceTaskPriorityForSide('), 'R138: priorité par camp absente');
const r138Queue = extractFunction(app, 'contractChanceQueueForDeal');
assert(r138Queue.includes('if (!deal.ddTable)'), 'R138: statistiques lancées avant le DD exact');
assert(r138Queue.includes('contractChanceQueueFastPrimary(deal, auctionFinished)'), 'R139: contrat de PAR rapide non priorisé');
assert(r138Queue.includes('if (!fastPrimaryReady) return'), 'R139: tables complètes peuvent passer avant les 24 rapides');
assert(r138Queue.includes('if (!auctionFinished) return'), 'R139: tables statistiques complètes encore calculées pendant les enchères');
const r139Fast = extractFunction(app, 'contractChanceQueueFastPrimary');
assert(r139Fast.includes('localDdsSolveContract(pbn, targetStrain, declarer, allowConditioning ? 300 : 210, fastState.groupKey)'), 'R139: PAR principal ne passe pas par SolveBoard rapide');
const r139Progress = extractFunction(app, 'contractChanceTargetProgress');
assert(r139Progress.includes('contractChanceFastPrimaryStats(deal, target)'), 'R139: affichage ne consomme pas le résultat rapide');
const r139Kickoff = extractFunction(app, 'kickOffBackgroundDD');
assert(!r139Kickoff.includes('for (let i = 1; i < dealsList.length'), 'R139: DD des donnes futures peut encore monopoliser les Workers');
const r138Adapt = extractFunction(app, 'contractChanceUpdateAdaptiveTargets');
assert(r138Adapt.includes('CONTRACT_CHANCE_TARGET).length < CONTRACT_CHANCE_TARGET'), 'R138: 48/72 peut démarrer avant les bases 24');
const r138Guest = extractFunction(app, 'contractChanceSolveGuestWork');
assert(r138Guest.includes('localDdsSolveItems(workItems, 145)'), 'R138: invité ne résout pas le DDS en local');
assert(!r138Guest.includes('contractChanceFetchLane('), 'R138: collaboration invitée contient encore un DDS distant');
const r138Dispatch = extractFunction(app, 'contractChanceDispatchCollaborativeWork');
assert(r138Dispatch.includes('if (!CONTRACT_CHANCE_LOCAL_DDS_ENABLED) return 0'), 'R138: collaboration locale non activée');

// R140 — contrats secondaires par SolveBoard, groupés par couleur + déclarant.
assert(app.includes('const CONTRACT_CHANCE_DIRECT_MAX_CELLS_PER_SIDE = 4'), 'R140: seuil direct par camp absent');
assert(app.includes('function contractChanceDirectTargetCell('), 'R140: cellule DDS contrat-seul absente');
assert(app.includes('function contractChanceDirectCellGroups('), 'R140: regroupement des niveaux par cellule absent');
assert(app.includes('function contractChanceCanUseDirectTargetMode('), 'R140: sélection du mode direct absente');
assert(app.includes('function contractChanceUpdateDirectAdaptiveTargets('), 'R140: adaptatif direct 24/48/72 absent');
const r140Queue = extractFunction(app, 'contractChanceQueueForDeal');
assert(r140Queue.includes('contractChanceCanUseDirectTargetMode(deal, contract)'), 'R140: chemin direct secondaire non branché');
assert(r140Queue.includes('contractChanceQueueDirectTargetsForSide('), 'R140: cibles secondaires non envoyées à SolveBoard');
const r140Cell = extractFunction(app, 'contractChanceQueueDirectCell');
assert(r140Cell.includes('localDdsSolveContract('), 'R140: cellule secondaire ne passe pas par DDS contrat-seul');
const r140Progress = extractFunction(app, 'contractChanceTargetProgress');
assert(r140Progress.includes('contractChanceDirectTargetStats(deal, target)'), 'R140: affichage ne consomme pas le cache direct secondaire');
assert(r138Dispatch.includes('contractChanceCanUseDirectTargetMode(deal, contract)'), 'R140: collaboration table peut encore concurrencer le mode direct');

// R141 — cache DDS terminé + raffinement adaptatif indépendant par cellule.
assert(app.includes('const LOCAL_DDS_CONTRACT_CACHE_LIMIT = 1536'), 'R141: cache DDS contrat absent');
assert(app.includes('const LOCAL_DDS_TABLE_CACHE_LIMIT = 128'), 'R141: cache DDS table absent');
const r141SolveContract = extractFunction(app, 'localDdsSolveContract');
assert(r141SolveContract.includes('localDdsCacheGet(localDdsContractResultCache, cacheKey)'), 'R141: résultat contrat terminé non réutilisé');
const r141SolveTable = extractFunction(app, 'localDdsSolveOne');
assert(r141SolveTable.includes('localDdsCacheGet(localDdsTableResultCache, normalizedPbn)'), 'R141: résultat table terminé non réutilisé');
const r141QueueDirect = extractFunction(app, 'contractChanceQueueDirectTargetsForSide');
assert(r141QueueDirect.includes('state.adaptiveTarget'), 'R141: objectif direct encore piloté globalement par le camp');
const r141AdaptDirect = extractFunction(app, 'contractChanceUpdateDirectAdaptiveTargets');
assert(r141AdaptDirect.includes('cellState.adaptiveTarget'), 'R141: raffinement par cellule absent');
assert(r141AdaptDirect.includes('cellState.adaptiveSettled = true'), 'R141: stabilisation indépendante par cellule absente');
assert(r140Progress.includes("source === 'direct' && Number.isFinite(Number(directStats && directStats.goal))"), 'R141: affichage n’utilise pas l’objectif propre de la cellule');

// R142 — pourcentage provisoire tôt + rafraîchissements UI/P2P regroupés.
assert(/const\s+CONTRACT_CHANCE_EARLY_PCT_MIN_SAMPLES\s*=\s*8\s*;/.test(app), 'R142: seuil du premier pourcentage modifié');
assert(/const\s+CONTRACT_CHANCE_REFRESH_THROTTLE_MS\s*=\s*90\s*;/.test(app), 'R142: throttle d’affichage absent');
const r142Text = extractFunction(app, 'contractChanceProgressText');
assert(r142Text.includes('n >= CONTRACT_CHANCE_EARLY_PCT_MIN_SAMPLES'), 'R142: pourcentage provisoire avant 24 absent');
assert(r142Text.includes('pct.toFixed(0)') && r142Text.includes('CONTRACT_CHANCE_EARLY_PCT_MIN_SAMPLES'), 'R142: texte pourcentage + progression absent');
assert(r142Text.includes('CONTRACT_CHANCE_TARGET'), 'R142: compteur initial avant seuil absent');
const r142Schedule = extractFunction(app, 'scheduleContractChanceDisplayRefresh');
assert(r142Schedule.includes('CONTRACT_CHANCE_REFRESH_THROTTLE_MS'), 'R142: scheduler n’utilise pas le throttle');
assert(r142Schedule.includes('refreshContractChanceDisplayForDeal(deal)'), 'R142: scheduler ne rafraîchit pas l’affichage');
assert(r139Fast.includes('scheduleContractChanceDisplayRefresh(deal, milestone)'), 'R142: primaire ne passe pas par le scheduler');
assert(r140Cell.includes('scheduleContractChanceDisplayRefresh(deal, milestone)'), 'R142: secondaires ne passent pas par le scheduler');

console.log('PLAY regression gate PASS');
