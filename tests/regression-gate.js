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

function compileFunction(source, name, context = {}) {
    const fnText = extractFunction(source, name);
    return vm.runInNewContext(`${fnText}\n${name};`, { ...context });
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
const established = compileFunction(app, 'contractChanceEstablishedDeclarerForStrain', {
    parseBid,
    statisticalParSideFromDeclarer: sideFromDeclarer
});
assert(established({ auctionHistory: [{ seat: 'N', call: '1NT' }, { seat: 'E', call: 'PASS' }, { seat: 'S', call: '6NT' }] }, { declarer: 'N', strain: 'NT' }, 'NS', 'N') === 'N', 'R122: déclarant SA établi incorrect');

const progressMap = new Map([['N', '75%'], ['S', '100%']]);
const groupHtml = compileFunction(app, 'contractChanceSidecarSideGroupHtml', {
    contractChanceEstablishedDeclarerForStrain: established,
    contractChanceTargetProgress: (_deal, _contract, target) => ({ text: progressMap.get(target.declarer), done: true }),
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

console.log('PLAY regression gate PASS');
