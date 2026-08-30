'use strict';

// R133 — adaptateur temporaire de la gate historique.
//
// On conserve intégralement tests/regression-gate.js et toutes ses assertions R120..R128.
// La seule section devenue volontairement fausse est la section R131 qui exigeait les
// endpoints DDS Vercel A/B. On remplace cette section EN MÉMOIRE par les invariants R133,
// puis on exécute le reste du fichier sans modifier la couverture historique.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const legacyPath = path.join(__dirname, 'regression-gate.js');
const legacySource = fs.readFileSync(legacyPath, 'utf8');

// R139 CI compat — la gate historique compile contractChanceUpdateAdaptiveTargets()
// isolément dans un vm. R138 lui a ajouté le helper d'ordonnancement PAR-first
// contractChanceOrderedSides(), présent au runtime dans app.js mais absent de ce petit
// contexte de test. On fournit uniquement un stub neutre à CET ancien test adaptatif :
// il ne teste pas l'ordre des camps, seulement les transitions 24 -> 48 -> 72.
const adaptiveContextNeedle = "contractChanceGeneration: 7,\n        contractChanceTargetsForDeal:";
const adaptiveContextReplacement = "contractChanceGeneration: 7,\n        contractChanceOrderedSides: (_deal, sides) => Array.isArray(sides) ? sides : ['NS', 'EW'],\n        contractChanceTargetsForDeal:";
const source = legacySource.replace(adaptiveContextNeedle, adaptiveContextReplacement);
if (source === legacySource) {
    throw new Error('R139 CI: contexte adaptatif historique introuvable');
}
const localDdsWorkerPath = path.join(__dirname, '..', 'dds', 'local-dds-worker.js');
const localDdsWorker = fs.readFileSync(localDdsWorkerPath, 'utf8');
if (!localDdsWorker.includes("msg.type !== 'solve' && msg.type !== 'solve-contract'")) {
    throw new Error('R139: Worker DDS contrat-seul absent');
}
if (!localDdsWorker.includes("'dds_web_solve_leads'")) {
    throw new Error('R139: chemin SolveBoard rapide absent du Worker');
}


const startMarker = '// 8) R131 : parallélisme Vercel mesuré — une vague de 24 = 6 lots de 4';
const endMarker = "console.log('PLAY regression gate PASS');";

const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0 || end <= start) {
    throw new Error('R133: section R131 historique introuvable dans regression-gate.js');
}

const replacement = String.raw`// ---------------------------------------------------------------------------
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

console.log('PLAY regression gate PASS');`;

const patched =
    source.slice(0, start) +
    replacement +
    source.slice(end + endMarker.length);

const compiled = new Module(legacyPath, module);
compiled.filename = legacyPath;
compiled.paths = Module._nodeModulePaths(path.dirname(legacyPath));
compiled._compile(patched, legacyPath);
