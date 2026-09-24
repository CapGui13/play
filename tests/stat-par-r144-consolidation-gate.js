const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'statistical-par-runtime-patch.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
function must(cond, msg) { if (!cond) throw new Error(msg); }

must(app.includes('CONTRACT_CHANCE_LOCAL_BATCH_SIZE = 4'), 'local batch size missing');
must(app.includes('CONTRACT_CHANCE_MAX_LOCAL_BATCHES = 6'), 'local batch concurrency missing');
must(app.includes('contractChanceActiveBatches'), 'local batch counter missing');
must(!app.includes('CONTRACT_CHANCE_REMOTE_DDS_ENABLED'), 'legacy remote DDS flag still present');
must(!app.includes('CONTRACT_CHANCE_NATIVE_URLS'), 'legacy remote DDS lanes still present');
must(!app.includes('CONTRACT_CHANCE_LEGACY_URL'), 'legacy remote DDS URL still present');
must(!app.includes('function contractChanceFetchLane'), 'legacy remote DDS fetch function still present');

must(app.includes('function statisticalParStableJson'), 'semantic PONS serializer not native in app.js');
must(app.includes('pons-public-semantic:${statisticalParStableJson(constraints)}'), 'semantic PONS key not native in app.js');
must(!runtime.includes('originalPublicConditioning'), 'runtime patch still monkey-patches PONS identity');
must(app.includes('function contractChancePopulationPlan'), 'unified population plan missing');
const planUses = (app.match(/contractChancePopulationPlan\(/g) || []).length;
must(planUses >= 4, 'population plan is not shared across schedulers');

must(app.includes('function randomDealRuntimeBaselineReady'), 'server baseline boundary missing');
must(app.includes("indexes.size < CONTRACT_CHANCE_TARGET"), '24-sample baseline rule missing');
must(app.includes('contractChanceHydratePoolPrecompute'), 'pool hydration naming missing');
must(!app.includes('contractChanceHydrateRemotePrecompute'), 'obsolete remote hydration naming remains');
must(/r14[45]-20260921-statpar-(?:consolidation|resilience)/.test(sw), 'service worker cache not compatible with R144+');

// UI contract: this pass is internal; no new visible R144 labels or DOM hooks are introduced.
must(!app.includes('R144_DEBUG_PANEL'), 'unexpected UI/debug panel introduced');
console.log('Stat PAR R144 consolidation gate: PASS');
