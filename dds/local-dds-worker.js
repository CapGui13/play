'use strict';

// PLAY R133 — DDS officiel compilé en WebAssembly, exécuté hors du thread UI.
// Ce Worker ne fait aucun appel à un service de calcul : il charge uniquement les deux
// fichiers statiques voisins dds_web_wasm.js / dds_web_wasm.wasm depuis GitHub Pages.

const DDS_STRAINS = ['S', 'H', 'D', 'C', 'N'];
const DDS_SEATS = ['N', 'E', 'S', 'W'];
let ddsModulePromise = null;

async function loadDdsModule() {
    if (ddsModulePromise) return ddsModulePromise;
    ddsModulePromise = (async () => {
        importScripts('./dds_web_wasm.js');
        if (typeof createDdsModule !== 'function') {
            throw new Error('Factory DDS WASM introuvable');
        }

        // Le loader Emscripten officiel recherche un nom de .wasm interne différent du
        // nom de l'artefact publié. On fournit donc explicitement les octets compilés :
        // aucun chemin implicite, aucun CDN et aucun serveur de calcul.
        const response = await fetch('./dds_web_wasm.wasm', { cache: 'default' });
        if (!response.ok) throw new Error(`DDS WASM HTTP ${response.status}`);
        const wasmBinary = await response.arrayBuffer();
        return createDdsModule({ wasmBinary });
    })().catch(err => {
        ddsModulePromise = null;
        throw err;
    });
    return ddsModulePromise;
}

function solveTable(module, pbn) {
    const normalized = String(pbn || '').trim();
    if (!/^N:/.test(normalized)) throw new Error('PBN DDS invalide');

    const outPtr = module._malloc(20 * 4);
    if (!outPtr) throw new Error('Allocation DDS impossible');
    try {
        const rc = module.ccall(
            'dds_web_calc_table',
            'number',
            ['string', 'number'],
            [normalized, outPtr]
        );
        if (rc !== 1) throw new Error(`dds_web_calc_table=${rc}`);

        const table = { N: {}, S: {}, H: {}, D: {}, C: {} };
        let k = 0;
        for (const strain of DDS_STRAINS) {
            for (const seat of DDS_SEATS) {
                const tricks = Number(module.getValue(outPtr + k * 4, 'i32'));
                if (!Number.isInteger(tricks) || tricks < 0 || tricks > 13) {
                    throw new Error(`Résultat DDS invalide ${strain}/${seat}: ${tricks}`);
                }
                table[strain][seat] = tricks;
                k++;
            }
        }
        return table;
    } finally {
        module._free(outPtr);
    }
}

self.onmessage = async event => {
    const msg = event && event.data || {};
    if (msg.type !== 'solve') return;
    const requestId = String(msg.requestId || '');
    try {
        const module = await loadDdsModule();
        const table = solveTable(module, msg.pbn);
        self.postMessage({ type: 'result', requestId, table });
    } catch (err) {
        self.postMessage({
            type: 'error',
            requestId,
            error: String(err && err.message || err || 'DDS local en erreur')
        });
    }
};
