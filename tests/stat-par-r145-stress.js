const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function must(cond, msg) { if (!cond) throw new Error(msg); }

const fnMatch = app.match(/function contractChanceSupervisorDecision\([\s\S]*?\n}\n/);
must(fnMatch, 'supervisor decision helper not found');
const sandbox = {
  CONTRACT_CHANCE_SUPERVISOR_MAX_RECOVERIES: 3,
  CONTRACT_CHANCE_SUPERVISOR_HARD_STALL_MS: 15000,
  CONTRACT_CHANCE_SUPERVISOR_INTERVAL_MS: 2500,
  CONTRACT_CHANCE_SUPERVISOR_SOFT_STALL_MS: 8000
};
vm.createContext(sandbox);
vm.runInContext(`${fnMatch[0]}; this.decide = contractChanceSupervisorDecision;`, sandbox);
const decide = sandbox.decide;

must(decide(0,0,99999) === 'none', 'fresh work must not recover');
must(decide(7999,0,99999) === 'none', 'pre-soft threshold must not recover');
must(decide(8000,0,99999) === 'soft', 'soft threshold missing');
must(decide(14999,1,99999) === 'none', 'second soft recovery should not loop');
must(decide(15000,1,2499) === 'none', 'hard recovery cooldown ignored');
must(decide(15000,1,2500) === 'hard', 'hard threshold missing');
must(decide(60000,3,60000) === 'none', 'max recovery bound ignored');

// Stress déterministe sur 50 000 états : aucune décision ne doit violer les bornes.
let x = 0x1452026;
function rnd() { x = (x * 1664525 + 1013904223) >>> 0; return x; }
let soft = 0, hard = 0, none = 0;
for (let i = 0; i < 50000; i++) {
  const stall = rnd() % 60001;
  const recoveries = rnd() % 6;
  const since = rnd() % 10001;
  const d = decide(stall, recoveries, since);
  must(['none','soft','hard'].includes(d), 'invalid decision');
  if (recoveries >= 3) must(d === 'none', 'recovery cap violated');
  if (d === 'soft') {
    soft++;
    must(recoveries === 0 && stall >= 8000 && stall < 15000, 'invalid soft recovery');
  } else if (d === 'hard') {
    hard++;
    must(recoveries < 3 && stall >= 15000 && since >= 2500, 'invalid hard recovery');
  } else none++;
}
must(soft > 0 && hard > 0 && none > 0, 'stress did not cover all branches');
console.log(`Stat PAR R145 stress: PASS (${soft} soft, ${hard} hard, ${none} none)`);
