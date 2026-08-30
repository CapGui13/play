'use strict';

// PLAY R133 — DDS officiel compilé en WebAssembly, exécuté hors du thread UI.
// Ce Worker ne fait aucun appel à un service de calcul : il charge uniquement les deux
// fichiers statiques voisins dds_web_wasm.js / dds_web_wasm.wasm depuis GitHub Pages.

const DDS_STRAINS = ['S', 'H', 'D', 'C', 'N'];
const DDS_SEATS = ['N', 'E', 'S', 'W'];
let ddsModulePromise = null;
let tableOutPtr = 0;
let leadsOutPtr = 0;

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

    // R139 — le Worker est mono-tâche : garder le petit buffer de sortie entre les
    // appels évite malloc/free sur chaque redistribution statistique.
    if (!tableOutPtr) tableOutPtr = module._malloc(20 * 4);
    if (!tableOutPtr) throw new Error('Allocation DDS impossible');
    const rc = module.ccall(
        'dds_web_calc_table',
        'number',
        ['string', 'number'],
        [normalized, tableOutPtr]
    );
    if (rc !== 1) throw new Error(`dds_web_calc_table=${rc}`);

    const table = { N: {}, S: {}, H: {}, D: {}, C: {} };
    let k = 0;
    for (const strain of DDS_STRAINS) {
        for (const seat of DDS_SEATS) {
            const tricks = Number(module.getValue(tableOutPtr + k * 4, 'i32'));
            if (!Number.isInteger(tricks) || tricks < 0 || tricks > 13) {
                throw new Error(`Résultat DDS invalide ${strain}/${seat}: ${tricks}`);
            }
            table[strain][seat] = tricks;
            k++;
        }
    }
    return table;
}

// R139 — chemin rapide pour le contrat de PAR principal. CalcDDtable calcule les
// 20 combinaisons couleur/déclarant ; pour une probabilité de contrat on n'a besoin
// que d'UNE combinaison. dds_web_solve_leads résout cette combinaison et renvoie les
// levées optimales des défenseurs pour chaque entame ; le déclarant fait 13 - max(def).
function solveContractTricks(module, pbn, strain, declarer) {
    const normalized = String(pbn || '').trim();
    if (!/^N:/.test(normalized)) throw new Error('PBN DDS invalide');
    const strainIndex = DDS_STRAINS.indexOf(String(strain || '').toUpperCase());
    const declarerIndex = DDS_SEATS.indexOf(String(declarer || '').toUpperCase());
    if (strainIndex < 0 || declarerIndex < 0) throw new Error('Contrat DDS rapide invalide');
    const first = (declarerIndex + 1) % 4;
    if (!leadsOutPtr) leadsOutPtr = module._malloc((1 + 13 * 3) * 4);
    if (!leadsOutPtr) throw new Error('Allocation DDS entames impossible');

    const rc = module.ccall(
        'dds_web_solve_leads',
        'number',
        ['string', 'number', 'number', 'number'],
        [normalized, strainIndex, first, leadsOutPtr]
    );
    if (rc !== 1) throw new Error(`dds_web_solve_leads=${rc}`);
    const count = Number(module.getValue(leadsOutPtr, 'i32'));
    if (!Number.isInteger(count) || count < 1 || count > 13) throw new Error(`Entames DDS invalides: ${count}`);
    let maxDefenderTricks = -1;
    for (let i = 0; i < count; i++) {
        const score = Number(module.getValue(leadsOutPtr + (1 + 3 * i + 2) * 4, 'i32'));
        if (!Number.isInteger(score) || score < 0 || score > 13) throw new Error(`Score DDS entame invalide: ${score}`);
        if (score > maxDefenderTricks) maxDefenderTricks = score;
    }
    return 13 - maxDefenderTricks;
}

self.onmessage = async event => {
    const msg = event && event.data || {};
    if (msg.type !== 'solve' && msg.type !== 'solve-contract') return;
    const requestId = String(msg.requestId || '');
    try {
        const module = await loadDdsModule();
        if (msg.type === 'solve-contract') {
            const tricks = solveContractTricks(module, msg.pbn, msg.strain, msg.declarer);
            self.postMessage({ type: 'contract-result', requestId, tricks });
            return;
        }
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
