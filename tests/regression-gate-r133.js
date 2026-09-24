'use strict';

// R133 — adaptateur de compatibilité de la gate historique.
//
// Depuis R143.2, tests/regression-gate.js est modernisée et exécutable directement par la
// CI. Ce wrapper reste conservé pour compatibilité avec d'anciens paquets : s'il rencontre
// encore la vieille section R131/Vercel, il la remplace en mémoire par les invariants R133 ;
// sinon il exécute simplement la gate courante telle quelle.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const legacyPath = path.join(__dirname, 'regression-gate.js');
const legacySource = fs.readFileSync(legacyPath, 'utf8');

// R143.2 — le workflow de production doit réellement exécuter les gates présentes dans
// le dépôt. Cette assertion vit dans la gate R133, elle-même appelée explicitement par le
// workflow, afin qu'une suppression accidentelle de regression-gate.js / BRL / pool soit
// détectée avant le déploiement.
const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml');
const workflowSource = fs.readFileSync(workflowPath, 'utf8');
for (const command of [
    'node tests/regression-gate-r133.js',
    'node tests/regression-gate.js',
    'node tests/brl-engine-gate.js',
    'node tests/deal-pool-gate.js'
]) {
    if (!workflowSource.includes(command)) throw new Error(`R143.2 CI: gate non exécutée par deploy.yml: ${command}`);
}

// R139 CI compat — la gate historique compile contractChanceUpdateAdaptiveTargets()
// isolément dans un vm. R138 lui a ajouté le helper d'ordonnancement PAR-first
// contractChanceOrderedSides(), présent au runtime dans app.js mais absent de ce petit
// contexte de test. On fournit uniquement un stub neutre à CET ancien test adaptatif :
// il ne teste pas l'ordre des camps, seulement les transitions 24 -> 48 -> 72.
const adaptiveContextNeedle = "contractChanceGeneration: 7,\n        contractChanceTargetsForDeal:";
const adaptiveContextReplacement = "contractChanceGeneration: 7,\n        contractChanceOrderedSides: (_deal, sides) => Array.isArray(sides) ? sides : ['NS', 'EW'],\n        contractChanceTargetsForDeal:";
// R143.2 : regression-gate.js contient désormais lui-même ce contexte, puisqu'il est
// exécuté directement par la CI. Garder ce shim uniquement pour compatibilité avec une
// ancienne copie de la gate, sans exiger que le vieux motif existe encore.
let source = legacySource.includes(adaptiveContextNeedle)
    ? legacySource.replace(adaptiveContextNeedle, adaptiveContextReplacement)
    : legacySource;

// R142 CI hardening — les tests historiques utilisent compileFunction() pour exécuter
// une fonction d'app.js dans un vm minimal. Jusqu'ici, chaque nouveau helper appelé par
// cette fonction devait être ajouté manuellement au contexte du test, ce qui a provoqué
// les échecs de déploiement #453 puis #457 alors que le runtime PLAY était valide.
//
// On rend ce compilateur de test auto-suffisant : il embarque récursivement les fonctions
// app.js appelées par la fonction testée, ainsi que les constantes scalaires simples dont
// elles dépendent. Les valeurs explicitement fournies par un test gardent toujours la
// priorité. Cela conserve l'isolation des tests sans les coupler à chaque refactor interne.
const legacyCompileFunction = `function compileFunction(source, name, context = {}) {
    const fnText = extractFunction(source, name);
    return vm.runInNewContext(\`${'${fnText}'}\\n${'${name}'};\`, { ...context });
}`;
const resilientCompileFunction = `function compileFunction(source, name, context = {}) {
    const sandbox = { ...context };
    const seenFunctions = new Set();
    const functionChunks = [];
    const scalarChunks = [];
    const seenScalars = new Set();

    function maybeCollectScalar(identifier, text) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(identifier)) return;
        if (Object.prototype.hasOwnProperty.call(sandbox, identifier) || seenScalars.has(identifier)) return;
        const re = new RegExp('(?:^|\\\\n)\\\\s*const\\\\s+' + identifier + '\\\\s*=\\\\s*([^;\\\\n]+)\\\\s*;', 'm');
        const match = source.match(re);
        if (!match) return;
        const expression = String(match[1] || '').trim();
        if (!/^(?:-?\\d+(?:\\.\\d+)?|true|false|null|undefined|'[^'\\n]*'|"[^"\\n]*")$/.test(expression)) return;
        seenScalars.add(identifier);
        scalarChunks.push('const ' + identifier + ' = ' + expression + ';');
    }

    function collect(functionName) {
        if (seenFunctions.has(functionName) || Object.prototype.hasOwnProperty.call(sandbox, functionName)) return;
        const marker = 'function ' + functionName + '(';
        if (!source.includes(marker)) return;
        seenFunctions.add(functionName);
        const text = extractFunction(source, functionName);
        const identifiers = text.match(/\\b[A-Za-z_$][A-Za-z0-9_$]*\\b/g) || [];
        for (const identifier of identifiers) maybeCollectScalar(identifier, text);
        const callRe = /\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(/g;
        let match;
        while ((match = callRe.exec(text))) {
            const dependency = match[1];
            if (dependency !== functionName && source.includes('function ' + dependency + '(')) collect(dependency);
        }
        functionChunks.push(text);
    }

    collect(name);
    if (!seenFunctions.has(name) && !Object.prototype.hasOwnProperty.call(sandbox, name)) {
        fail('Fonction introuvable: ' + name);
    }
    const program = scalarChunks.join('\\n') + '\\n' + functionChunks.join('\\n') + '\\n' + name + ';';
    return vm.runInNewContext(program, sandbox);
}`;
if (source.includes(legacyCompileFunction)) {
    source = source.replace(legacyCompileFunction, resilientCompileFunction);
} else if (!source.includes('const seenFunctions = new Set()')) {
    throw new Error('R143.2 CI: compileFunction résilient introuvable');
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
const end = start >= 0 ? source.indexOf(endMarker, start) : -1;

// R143.2 : regression-gate.js est désormais modernisée en dur. Conserver l'adaptateur
// uniquement pour une ancienne copie qui contiendrait encore la section R131 historique.
const replacement = String.raw`// ---------------------------------------------------------------------------
// 8) R133 : DDS WebAssembly local — aucun calcul DDS Vercel
// ---------------------------------------------------------------------------
assert(/const\s+LOCAL_DDS_WORKER_URL\s*=\s*'dds\/local-dds-worker\.js'\s*;/.test(app), 'R133: Worker DDS local absent');
assert(/const\s+LOCAL_DDS_BROWSER_ENABLED\s*=\s*typeof Worker === 'function'\s*;/.test(app), 'R133: détection Worker DDS local absente');
assert(/const\s+LOCAL_DDS_MAX_DESKTOP_WORKERS\s*=\s*4\s*;/.test(app), 'R138: plafond desktop DDS local modifié');
assert(/const\s+CONTRACT_CHANCE_LOCAL_DDS_ENABLED\s*=\s*LOCAL_DDS_BROWSER_ENABLED\s*;/.test(app), 'R133: PAR statistique non relié au DDS local');
assert(!/CONTRACT_CHANCE_REMOTE_DDS_ENABLED/.test(app), 'R144: drapeau DDS distant legacy encore présent');
assert(!/CONTRACT_CHANCE_NATIVE_URLS/.test(app), 'R144: lanes DDS distantes legacy encore présentes');
assert(!/CONTRACT_CHANCE_LEGACY_URL/.test(app), 'R144: URL DDS legacy encore présente');

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

assert(!app.includes('function contractChanceFetchLane'), 'R144: ancien fetch DDS distant encore présent');

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

console.log('PLAY regression gate PASS');`;

const patched = start >= 0 && end > start
    ? source.slice(0, start) + replacement + source.slice(end + endMarker.length)
    : source;

if (start < 0 && !source.includes('// 8) R133 : DDS WebAssembly local — aucun calcul DDS Vercel')) {
    throw new Error('R143.2: ni section R131 historique ni section R133 modernisée trouvée');
}

const compiled = new Module(legacyPath, module);
compiled.filename = legacyPath;
compiled.paths = Module._nodeModulePaths(path.dirname(legacyPath));
compiled._compile(patched, legacyPath);
