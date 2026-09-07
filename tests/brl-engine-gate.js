#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const context = {
  console,
  TextEncoder,
  Float32Array,
  ArrayBuffer,
  Uint8Array,
  Map,
  Math,
  Number,
  Object,
  String,
  Error,
  Promise,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'bidding-rules.js'), 'utf8'), context, { filename: 'bidding-rules.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'brl/brl-engine.js'), 'utf8'), context, { filename: 'brl-engine.js' });

const test = context.BrlEngine && context.BrlEngine._test;
assert(test, 'BrlEngine._test doit être exposé');

// 38 actions PGX/BRL : PASS, X, XX, puis 1C..7NT.
assert.strictEqual(test.actionToCall(0), 'PASS');
assert.strictEqual(test.actionToCall(1), 'X');
assert.strictEqual(test.actionToCall(2), 'XX');
assert.strictEqual(test.actionToCall(3), '1C');
assert.strictEqual(test.actionToCall(7), '1NT');
assert.strictEqual(test.actionToCall(8), '2C');
assert.strictEqual(test.actionToCall(37), '7NT');
for (let action = 0; action < 38; action++) {
  const call = test.actionToCall(action);
  assert.strictEqual(test.callToAction(call), action, `round-trip action ${action} / ${call}`);
}

// Le masque BRL doit être exactement gouverné par la légalité PLAY.
let mask = test.buildLegalMask([], 'N');
assert.strictEqual(mask.length, 38);
assert.strictEqual(mask[0], true, 'Passe légale à l’ouverture');
assert.strictEqual(mask[1], false, 'X illégal sans enchère adverse');
assert.strictEqual(mask[2], false, 'XX illégal sans X');
assert(mask.slice(3).every(Boolean), 'toutes les enchères chiffrées sont légales à l’ouverture');

mask = test.buildLegalMask([{ seat: 'N', call: '1C' }], 'E');
assert.strictEqual(mask[test.callToAction('X')], true, 'X adverse légal sur 1C');
assert.strictEqual(mask[test.callToAction('1C')], false, 'répéter 1C est illégal');
assert.strictEqual(mask[test.callToAction('1D')], true, '1D est légal sur 1C');

mask = test.buildLegalMask([
  { seat: 'N', call: '1C' },
  { seat: 'E', call: 'X' },
], 'S');
assert.strictEqual(mask[test.callToAction('XX')], true, 'XX légal après le X adverse');
assert.strictEqual(mask[test.callToAction('X')], false, 'second X illégal');

// Observation BRL/PGX : 480 valeurs, vulnérabilité relative + 13 cartes.
const hand = { S: 'AKQJT98765432', H: '', D: '', C: '' };
let obs = test.encodeObservation(hand, 'N', 'NS', [], 'N');
assert.strictEqual(obs.length, 480);
assert.deepStrictEqual(Array.from(obs.slice(0, 4)), [0, 1, 1, 0], 'vulnérabilité relative NS vs EW');
assert.strictEqual(Array.from(obs.slice(428)).reduce((a, b) => a + b, 0), 13, 'exactement 13 cartes encodées');
assert.strictEqual(obs[428 + 3 + 12 * 4], 1, 'As de pique encodé en index OpenSpiel');
assert.strictEqual(obs[428 + 3], 1, '2 de pique encodé en index OpenSpiel');

// Historique : deux passes initiales puis 1H ; vérifie les sièges relatifs.
obs = test.encodeObservation(
  { S: 'A', H: 'KQJ', D: 'T987', C: '65432' },
  'N',
  'None',
  [
    { seat: 'N', call: 'PASS' },
    { seat: 'E', call: 'PASS' },
    { seat: 'S', call: '1H' },
  ],
  'S'
);
assert.strictEqual(obs[4 + 2], 1, 'passe de N relative à S');
assert.strictEqual(obs[4 + 3], 1, 'passe de E relative à S');
const oneHAction = test.callToAction('1H');
assert.strictEqual(obs[8 + (oneHAction - 3) * 12 + 0], 1, '1H de l’acteur encodé au bon siège relatif');

// Smoke test de l'inférence MLP sans dépendre du réseau : poids nuls de la taille exacte.
const zeroModelBytes = new ArrayBuffer(14725276);
const zeroModel = new test.PolicyModel(zeroModelBytes);
const zeroMask = test.buildLegalMask([], 'N');
const zeroPolicy = zeroModel.policy(test.encodeObservation(hand, 'N', 'None', [], 'N'), zeroMask);
const legalCount = zeroMask.filter(Boolean).length;
assert.strictEqual(zeroPolicy.length, 38, 'la tête acteur produit 38 probabilités');
assert(Math.abs(Array.from(zeroPolicy).reduce((a, b) => a + b, 0) - 1) < 1e-5, 'softmax BRL normalisé');
assert(Math.abs(zeroPolicy[test.callToAction('1C')] - 1 / legalCount) < 1e-6, 'poids nuls => politique uniforme sur actions légales');
assert.strictEqual(zeroPolicy[test.callToAction('X')], 0, 'action illégale masquée par la politique');

// Contrats d’intégration UI/cache essentiels.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
assert(html.includes('src="brl/brl-engine.js"'), 'script BRL présent dans index.html');
assert(html.includes('value="brl-sl"'), 'option BRL-SL présente');
assert(html.includes('value="brl-rl-fsp"'), 'option BRL-RL-FSP présente');
assert(html.includes("connect-src 'self' https://raw.githubusercontent.com"), 'CSP autorise le chargement des poids BRL');
const uiEvents = fs.readFileSync(path.join(ROOT, 'ui-events.js'), 'utf8');
assert(uiEvents.includes("case 'robot-engine'"), 'route UI robot-engine présente');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
assert(sw.includes("'./brl/brl-engine.js'"), 'adaptateur BRL inclus dans le cache cœur');

console.log('BRL engine gate: PASS');
