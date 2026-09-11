'use strict';
const fs = require('fs');
const path = require('path');
const StatisticalPar = require('../statistical-par.js');

function fail(msg) { throw new Error(msg); }
function assert(cond, msg) { if (!cond) fail(msg); }
function stable(obj) { return JSON.stringify(obj); }

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

assert(app.includes("const RANDOM_DEAL_POOL_URL = 'https://api-gen-beta.vercel.app/api/deal-pool';"), 'endpoint deal-pool absent');
assert(app.includes('if (!generated) generated = generateRandomDeals(count, seatAssignment, constraints);'), 'fallback local absent');
assert(app.includes("dealsList.filter(deal => deal && !deal.par && !deal.ddTable).slice(0, 1)"), 'DDS exact précalculé non respecté');
assert(app.includes('contractChancePoolRawEntriesForCell'), 'réutilisation V2 absente');
assert(sw.includes('bridge-encheres-brl-r134-20260909-deal-pool'), 'cache service worker non versionné');

const hands = {
  N: { S: 'AKQJ', H: 'AKQ', D: 'AKQ', C: 'AKQ' },
  E: { S: 'T987', H: 'JT98', D: 'JT9', C: 'JT' },
  S: { S: '6543', H: '7654', D: '8765', C: '9' },
  W: { S: '2', H: '32', D: '432', C: '8765432' }
};
const config = {
  ok: true, mode: 'two-known-hands', knownSeats: ['N','S'], humanSeats: ['N','S'],
  randomizedSeats: ['E','W']
};
const a = { board: 1, dealer: 'N', vulnerable: 'None', statisticalSeedId: 'pool_test_seed', hands };
const b = { board: 14, dealer: 'E', vulnerable: 'Both', statisticalSeedId: 'pool_test_seed', hands };
for (let i = 0; i < 8; i++) {
  assert(stable(StatisticalPar.sampleHandsDeterministic(a, config, i)) === stable(StatisticalPar.sampleHandsDeterministic(b, config, i)),
    `seed pool non portable pour sample ${i}`);
}
const legacyA = { board: 1, dealer: 'N', vulnerable: 'None', hands };
const legacyB = { board: 14, dealer: 'E', vulnerable: 'Both', hands };
assert(StatisticalPar.deterministicSeedMaterial(legacyA, config, 0) !== StatisticalPar.deterministicSeedMaterial(legacyB, config, 0),
  'fallback legacy a changé de sémantique');

console.log('Deal pool gate: PASS');
