const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
function must(cond, msg) { if (!cond) throw new Error(msg); }

must(app.includes('CONTRACT_CHANCE_SUPERVISOR_SOFT_STALL_MS = 8000'), 'soft stall threshold missing');
must(app.includes('CONTRACT_CHANCE_SUPERVISOR_HARD_STALL_MS = 15000'), 'hard stall threshold missing');
must(app.includes('CONTRACT_CHANCE_SUPERVISOR_MAX_RECOVERIES = 3'), 'bounded supervisor recoveries missing');
must(app.includes('function contractChanceSupervisorTick()'), 'supervisor tick missing');
must(app.includes('function contractChanceSupervisorDecision('), 'supervisor decision helper missing');
must(app.includes('function contractChanceSupervisorRecover('), 'supervisor recovery missing');
must(app.includes('function localDdsRecycleStuckWorkers('), 'stuck Worker recycling missing');
must(app.includes('window.getStatParDiagnostic = contractChanceCurrentDiagnostic'), 'hidden diagnostic API missing');
must(app.includes('plan-change'), 'plan-change reset missing');
must(app.includes('contractChanceSupervisorEnsureRunning();'), 'supervisor is not started by scheduler');
must(app.includes('recycledWorkers'), 'recovery diagnostics missing');

// Le diagnostic R145 doit rester invisible : aucun panneau, bouton ou hook DOM dédié.
const r145Block = app.slice(app.indexOf('// ===== R145 — supervision'), app.indexOf('function contractChanceMustYieldToPons()'));
must(r145Block && !/createElement|insertAdjacentHTML|innerHTML\s*=|appendChild/.test(r145Block), 'R145 supervisor unexpectedly modifies UI');

// Les protections basses restent en place : superviseur et watchdog se complètent.
must(app.includes('LOCAL_DDS_TASK_TIMEOUT_MS = 20000'), 'Worker watchdog removed');
must(app.includes('slot.startedAt = Date.now()'), 'Worker start timestamp missing');

// Invariants simples du modèle de reprise.
const soft = 8000, hard = 15000, interval = 2500, max = 3;
must(soft > interval, 'soft threshold too aggressive');
must(hard > soft, 'hard threshold must follow soft threshold');
must(max >= 2 && max <= 5, 'recovery bound unreasonable');

// Contrat UI : mêmes fichiers visuels que R144.
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
must(sha('index.html') === '65bfba944e467a6aff1b24a99940afdb37adb080250079992c8dfabc3befb6f7', 'index.html changed in R145');
must(sha('styles.css') === 'e1f64ebe4341d1f71f3138f7bffe049fe58c2de88c7ee5897614e0dc5f9c8c11', 'styles.css changed in R145');

must(sw.includes('r145-20260921-statpar-resilience'), 'service worker cache not bumped to R145');
console.log('Stat PAR R145 resilience gate: PASS');
