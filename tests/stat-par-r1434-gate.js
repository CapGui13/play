const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'statistical-par-runtime-patch.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
function must(cond, msg) { if (!cond) throw new Error(msg); }
must(app.includes('robotBoardsResolving.has(boardIndex)'), 'R143.3 current-board PONS guard missing');
must(app.includes('LOCAL_DDS_TASK_TIMEOUT_MS = 20000'), 'DDS watchdog missing');
must(app.includes('groupKeys: new Set'), 'multi-owner DDS group tracking missing');
must(app.includes('CONTRACT_CHANCE_DDS_RETRY_LIMIT = 2'), 'bounded retry missing');
must(app.includes("const cacheKey = `${side === 'EW' ? 'EW' : 'NS'}|${conditioningKey}`"), 'semantic candidate cache key missing');
must(runtime.includes('CONTRACT_CHANCE_MAX_ATTEMPTS'), 'resume max sample range missing');
must(runtime.indexOf('if (!resumeCompatible(deal, resume)) return 0;') < runtime.indexOf('hydratedDeals.add(deal);'), 'hydration marking order is unsafe');
must(/r14[45]-20260921-statpar-(?:consolidation|resilience)/.test(sw), 'service worker cache version not bumped');
console.log('Stat PAR R143.4 gate: PASS');
