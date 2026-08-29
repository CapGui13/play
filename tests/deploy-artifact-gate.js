'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

const ROOT = path.resolve(__dirname, '..');
const siteArg = process.argv[2] || '_site';
const SITE = path.resolve(ROOT, siteArg);

assert(fs.existsSync(SITE) && fs.statSync(SITE).isDirectory(),
    `R129: artefact Pages introuvable: ${SITE}`);

const required = [
    'index.html',
    'styles.css',
    'app.js',
    'ui-events.js',
    'bidding-rules.js',
    'dealer-par.js',
    'statistical-par.js',
    'deal-parser.js',
    'peer-connection.js',
    'session-storage.js',
    'realtime-updates.js',
    'manifest.json',
    'sw.js',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/apple-icon-180.png',

    // PONS : chemin normal + fallbacks de résilience. R129 ne retire aucun de ces fichiers.
    'pons/bridge-engine-v1-browser.js',
    'pons/canonical-rules-v1.json',
    'pons/canonical-rules-v1.js',
    'pons/fiches-engine-v1-app.js',
    'pons/pons-critic.js',
    'pons/pons-engine.js',
    'pons/pons-semantic.js',
    'pons/pons-wasm-runtime.js',
    'pons/pons_wasm_bg.wasm',
    'pons/pons-wasm-embedded.js'
];

for (const rel of required) {
    const file = path.join(SITE, rel);
    assert(fs.existsSync(file), `R129: ressource runtime absente de Pages: ${rel}`);
    assert(fs.statSync(file).isFile(), `R129: ressource runtime invalide: ${rel}`);
    assert(fs.statSync(file).size > 0, `R129: ressource runtime vide: ${rel}`);
}

// L'ancien moteur de 519 ko n'est plus chargé par index.html et ne doit plus être publié.
assert(!fs.existsSync(path.join(SITE, 'bidding-engine.js')),
    'R129: bidding-engine.js mort est encore publié');

// Les fichiers de développement ne doivent plus partir sur GitHub Pages.
for (const rel of ['.git', '.github', 'tests', '_site']) {
    assert(!fs.existsSync(path.join(SITE, rel)),
        `R129: contenu de développement publié par erreur: ${rel}`);
}

const index = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
assert(!/\bbidding-engine\.js\b/.test(index),
    'R129: index.html référence encore bidding-engine.js');

// Vérifie les src/href locaux statiques du shell. Les URL absolues, data:, mailto:,
// ancres et ressources générées dynamiquement sont volontairement ignorées.
for (const match of index.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    let ref = match[1].trim();
    if (!ref ||
        ref.startsWith('#') ||
        ref.startsWith('data:') ||
        ref.startsWith('mailto:') ||
        ref.startsWith('tel:') ||
        /^https?:\/\//i.test(ref) ||
        ref.startsWith('//')) {
        continue;
    }
    ref = ref.split('#')[0].split('?')[0];
    if (!ref || ref === './' || ref === '/') continue;
    ref = ref.replace(/^\.\//, '');
    const resolved = path.join(SITE, ref);
    assert(fs.existsSync(resolved), `R129: référence locale index.html manquante: ${ref}`);
}

// Vérifie que tout le pré-cache du Service Worker pointe vers un fichier réellement livré.
const sw = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
const assetsMatch = sw.match(/const\s+CORE_ASSETS\s*=\s*\[([\s\S]*?)\]\s*;/);
assert(assetsMatch, 'R129: CORE_ASSETS introuvable dans sw.js');
const coreAssets = Array.from(assetsMatch[1].matchAll(/['"]([^'"]+)['"]/g), m => m[1]);

for (let ref of coreAssets) {
    if (ref === './' || ref === '/') continue;
    ref = ref.split('#')[0].split('?')[0].replace(/^\.\//, '');
    assert(fs.existsSync(path.join(SITE, ref)),
        `R129: CORE_ASSETS référence une ressource absente: ${ref}`);
}

// Les deux fallbacks PONS lourds restent explicitement présents : R129 nettoie le
// packaging, pas la résilience du moteur.
assert(fs.statSync(path.join(SITE, 'pons/canonical-rules-v1.js')).size > 1_000_000,
    'R129: fallback règles PONS anormalement absent/réduit');
assert(fs.statSync(path.join(SITE, 'pons/pons-wasm-embedded.js')).size > 1_000_000,
    'R129: fallback WASM PONS anormalement absent/réduit');

console.log('PLAY R129 deploy artifact gate PASS');
