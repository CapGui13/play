// brl/brl-engine.js — Adaptateur navigateur pour les modèles BRL de bridge bidding.
//
// Modèles originaux : harukaki/brl (Apache-2.0), paper CoG 2024
// "A Simple, Solid, and Reproducible Baseline for Bridge Bidding AI".
// Les poids float32 chargés ici sont une conversion déterministe des paramètres BRL,
// publiée par le projet Nickel Bridge. PLAY ne reprend pas son moteur : l'inférence,
// l'encodage PGX et l'adaptation aux structures PLAY sont implémentés ici.
//
// Pour ne pas gonfler chaque paquet PLAY de ~30 Mo, les poids sont chargés à la demande
// depuis une révision Git immuable, puis mis en cache par le Service Worker/HTTP du
// navigateur. Taille et Git blob SHA-1 sont vérifiés avant utilisation.
(function (global) {
    'use strict';

    const OBS_SIZE = 480;
    const ACTION_COUNT = 38;
    const SEATS = ['N', 'E', 'S', 'W'];
    const BID_STRAINS = ['C', 'D', 'H', 'S', 'NT'];
    const RANK_TO_OPEN_SPIEL = {
        '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6,
        '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12
    };
    const SUIT_TO_OPEN_SPIEL = { C: 0, D: 1, H: 2, S: 3 };

    // Commit ayant introduit les poids convertis ; le contenu des blobs est immuable.
    const MODEL_COMMIT = '27c8e0ff8947c1635dfea4c1b1a9e80a791b2840';
    const RAW_BASE = `https://raw.githubusercontent.com/brannondorsey/nickel-bridge/${MODEL_COMMIT}/packages/ai/models`;

    const COMMON_LAYERS = [
        { name: 'linear',   w: { shape: [480, 1024], offset: 0, size: 491520 }, b: { shape: [1024], offset: 491520, size: 1024 } },
        { name: 'linear_1', w: { shape: [1024, 1024], offset: 492544, size: 1048576 }, b: { shape: [1024], offset: 1541120, size: 1024 } },
        { name: 'linear_2', w: { shape: [1024, 1024], offset: 1542144, size: 1048576 }, b: { shape: [1024], offset: 2590720, size: 1024 } },
        { name: 'linear_3', w: { shape: [1024, 1024], offset: 2591744, size: 1048576 }, b: { shape: [1024], offset: 3640320, size: 1024 } },
        { name: 'actor',    w: { shape: [1024, 38], offset: 3641344, size: 38912 }, b: { shape: [38], offset: 3680256, size: 38 } }
    ];

    const MODELS = {
        'sl': {
            label: 'BRL-SL',
            file: 'sl.bin',
            bytes: 14725276,
            gitBlobSha1: 'a89b1dca483284d2b783f0ec5286c51c64091ba4'
        },
        'rl-fsp': {
            label: 'BRL-RL-FSP',
            file: 'rl-fsp.bin',
            bytes: 14725276,
            gitBlobSha1: '4d2d8a4a8cdf15056eda13cb4c70fe44170380da'
        }
    };

    const loadedModels = new Map();
    const loadingModels = new Map();

    function setStatus(text, kind, modelName) {
        if (typeof document === 'undefined') return;
        const select = document.getElementById('robotEngineSelect');
        if (select && modelName) {
            const expected = modelName === 'sl' ? 'brl-sl' : 'brl-rl-fsp';
            if (select.value && select.value !== expected) return;
        }
        const el = document.getElementById('ponsEngineStatus');
        if (!el) return;
        el.textContent = text;
        el.classList.remove('is-online', 'is-offline', 'is-warning');
        el.classList.add(kind || 'is-offline');
    }

    function modelNameFromEngine(engineName) {
        return engineName === 'brl-sl' ? 'sl' : 'rl-fsp';
    }

    function actionToCall(action) {
        if (action === 0) return 'PASS';
        if (action === 1) return 'X';
        if (action === 2) return 'XX';
        if (!Number.isInteger(action) || action < 3 || action >= ACTION_COUNT) return null;
        const bid = action - 3;
        const level = Math.floor(bid / 5) + 1;
        const strain = BID_STRAINS[bid % 5];
        return `${level}${strain}`;
    }

    function callToAction(call) {
        if (call === 'PASS') return 0;
        if (call === 'X') return 1;
        if (call === 'XX') return 2;
        const m = /^([1-7])(C|D|H|S|NT)$/.exec(String(call || '').toUpperCase());
        if (!m) return -1;
        return 3 + (Number(m[1]) - 1) * 5 + BID_STRAINS.indexOf(m[2]);
    }

    function seatIndex(seat) {
        const idx = SEATS.indexOf(seat);
        if (idx < 0) throw new Error(`BRL: siège invalide ${seat}`);
        return idx;
    }


    // Garde-fou de cohérence "humaine" autour du réseau BRL.
    //
    // Le modèle SL imite WBridge5 et le modèle RL-FSP est ensuite optimisé en self-play.
    // Un réseau de politique n'a, à lui seul, aucune contrainte symbolique disant qu'une
    // ouverture naturelle à 1 promet une force minimale. Le port Nickel Bridge ajoute
    // lui aussi une couche de contraintes SAYC avant l'argmax. PLAY implémente ici sa
    // propre couche, volontairement conservatrice : elle ne cherche pas à réécrire tout
    // un système d'enchères, seulement à éliminer les violations grossières et certaines
    // ouvertures dont le sens est suffisamment stable pour être contrôlé par la main.
    function handFacts(hand) {
        const HCP = { A: 4, K: 3, Q: 2, J: 1 };
        const lengths = {};
        let hcp = 0;
        for (const suit of ['S', 'H', 'D', 'C']) {
            const ranks = String(hand && hand[suit] || '').toUpperCase();
            lengths[suit] = ranks.length;
            for (const rank of ranks) hcp += HCP[rank] || 0;
        }
        const shape = Object.values(lengths).slice().sort((a, b) => b - a).join('-');
        const balanced = shape === '4-3-3-3' || shape === '4-4-3-2' || shape === '5-3-3-2';
        const ordered = Object.values(lengths).slice().sort((a, b) => b - a);
        const rule20 = hcp + (ordered[0] || 0) + (ordered[1] || 0);
        return { hcp, lengths, balanced, rule20 };
    }

    function parseContractCall(call) {
        const m = /^([1-7])(C|D|H|S|NT)$/.exec(String(call || '').toUpperCase());
        return m ? { level: Number(m[1]), strain: m[2] } : null;
    }

    function firstContractEntry(history) {
        for (const entry of history || []) {
            if (parseContractCall(entry && entry.call)) return entry;
        }
        return null;
    }

    function sideOf(seat) {
        return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
    }

    function brlCallPlausible(hand, history, actor, call) {
        call = String(call || '').toUpperCase();
        if (call === 'PASS') return true;

        const f = handFacts(hand);
        // Un contre/surcontre avec pratiquement aucun jeu est une des dérives les plus
        // visibles du réseau brut. Les seuils restent bas pour ne pas supprimer les
        // contres compétitifs ou de soutien légitimes.
        if (call === 'X') return f.hcp >= 7;
        if (call === 'XX') return f.hcp >= 8;

        const bid = parseContractCall(call);
        if (!bid) return false;
        const opening = !firstContractEntry(history);

        if (opening) {
            // Ouvertures naturelles au palier de 1 : cinq cartes en majeure, trois en
            // mineure et une force d'ouverture. La règle de 20 laisse passer les mains
            // distribuées de 10H qui sont de vraies ouvertures de bridge.
            if (bid.level === 1 && bid.strain !== 'NT') {
                const enoughStrength = f.hcp >= 11 || (f.hcp >= 10 && f.rule20 >= 20);
                if (!enoughStrength) return false;
                if ((bid.strain === 'H' || bid.strain === 'S') && f.lengths[bid.strain] < 5) return false;
                if ((bid.strain === 'C' || bid.strain === 'D') && f.lengths[bid.strain] < 3) return false;
                return true;
            }
            if (call === '1NT') return f.balanced && f.hcp >= 15 && f.hcp <= 17;
            if (call === '2C') return f.hcp >= 20;
            if (call === '2NT') return f.balanced && f.hcp >= 20 && f.hcp <= 22;
            if (bid.level === 2 && ['D', 'H', 'S'].includes(bid.strain)) {
                return f.lengths[bid.strain] >= 6 && f.hcp >= 5 && f.hcp <= 11;
            }
            if (bid.level === 3 && bid.strain !== 'NT') {
                return f.lengths[bid.strain] >= 7 && f.hcp <= 12;
            }
            // Une ouverture de 3SA/4SA/etc. est très conventionnelle. Plutôt que de
            // laisser un réseau self-play utiliser ces appels comme code arbitraire, on
            // n'autorise ici 3SA qu'avec une vraie main forte et régulière ; les autres
            // ouvertures à SA au-dessus restent rejetées.
            if (call === '3NT') return f.balanced && f.hcp >= 24;
            if (bid.strain === 'NT') return false;
            // Barrages très hauts : exiger au moins une vraie longue couleur.
            if (bid.level >= 4) return f.lengths[bid.strain] >= 7;
        }

        // En cours d'enchères, on reste beaucoup moins intrusif : seules les anomalies
        // manifestes sont éliminées. Cela préserve Stayman/Texas, cue-bids, quatrième
        // couleur, splinters, etc., que l'on ne peut pas juger par la longueur de la
        // couleur écrite sur le bouton.
        if (bid.level === 1 && bid.strain !== 'NT' && f.hcp < 5) return false;
        if (bid.strain === 'NT') {
            if (bid.level === 1 && f.hcp < 5) return false;
            if (bid.level === 2 && f.hcp < 7) return false;
            if (bid.level >= 3 && f.hcp < 9) return false;
        }
        if (f.hcp <= 3 && bid.strain !== 'NT') {
            // Avec 0-3H, une enchère de contrat n'est acceptable que comme barrage avec
            // une longue couleur réelle ; cela bloque notamment le 1P à 2H vu en test.
            if (bid.level <= 2 || f.lengths[bid.strain] < 7) return false;
        }

        // Surélévation naturelle du partenaire : au moins un minimum de fit. On ne fait
        // ce contrôle que lorsque la couleur a déjà été annoncée par NOTRE camp ; un
        // cue-bid de la couleur adverse reste donc libre.
        if (bid.strain !== 'NT') {
            const ourSide = sideOf(actor);
            const sameSuitByUs = (history || []).some(e => sideOf(e && e.seat) === ourSide && parseContractCall(e && e.call)?.strain === bid.strain);
            const sameSuitByThem = (history || []).some(e => sideOf(e && e.seat) !== ourSide && parseContractCall(e && e.call)?.strain === bid.strain);
            if (sameSuitByUs && !sameSuitByThem && f.lengths[bid.strain] < 2) return false;
        }
        return true;
    }

    function buildPlausibilityMask(hand, history, actor, legalMask) {
        const mask = new Array(ACTION_COUNT).fill(false);
        for (let action = 0; action < ACTION_COUNT; action++) {
            if (!legalMask[action]) continue;
            mask[action] = brlCallPlausible(hand, history, actor, actionToCall(action));
        }
        // PASS doit rester un filet de sécurité absolu et est légal dans toute enchère
        // non terminée. Si un futur changement de garde-fou filtrait tout, on ne force
        // jamais une annonce arbitraire.
        if (legalMask[0]) mask[0] = true;
        return mask;
    }

    function encodeObservation(hand, dealer, vulnerable, history, actor) {
        if (!hand) throw new Error(`BRL: main ${actor} absente`);
        const obs = new Float32Array(OBS_SIZE);
        const actorIdx = seatIndex(actor);
        const dealerIdx = seatIndex(dealer);

        const actorSide = (actor === 'N' || actor === 'S') ? 'NS' : 'EW';
        const usVul = vulnerable === 'Both' || vulnerable === actorSide;
        const themSide = actorSide === 'NS' ? 'EW' : 'NS';
        const themVul = vulnerable === 'Both' || vulnerable === themSide;
        obs[0] = usVul ? 0 : 1;
        obs[1] = usVul ? 1 : 0;
        obs[2] = themVul ? 0 : 1;
        obs[3] = themVul ? 1 : 0;

        let lastBidAction = 0;
        for (let i = 0; i < history.length; i++) {
            const action = callToAction(history[i].call);
            if (action < 0) throw new Error(`BRL: annonce inconnue ${history[i].call}`);
            const relative = (((i + dealerIdx) % 4) + (4 - actorIdx)) % 4;
            if (action === 0) {
                if (lastBidAction === 0) obs[4 + relative] = 1;
            } else if (action === 1) {
                if (lastBidAction >= 3) obs[8 + (lastBidAction - 3) * 12 + 4 + relative] = 1;
            } else if (action === 2) {
                if (lastBidAction >= 3) obs[8 + (lastBidAction - 3) * 12 + 8 + relative] = 1;
            } else {
                lastBidAction = action;
                obs[8 + (action - 3) * 12 + relative] = 1;
            }
        }

        for (const suit of ['S', 'H', 'D', 'C']) {
            const ranks = String(hand[suit] || '').toUpperCase();
            for (const rank of ranks) {
                const rankIdx = RANK_TO_OPEN_SPIEL[rank];
                if (rankIdx == null) throw new Error(`BRL: rang invalide ${rank}`);
                const cardIdx = SUIT_TO_OPEN_SPIEL[suit] + rankIdx * 4;
                obs[428 + cardIdx] = 1;
            }
        }
        return obs;
    }

    function buildLegalMask(history, actor) {
        const mask = new Array(ACTION_COUNT).fill(false);
        for (let action = 0; action < ACTION_COUNT; action++) {
            const call = actionToCall(action);
            mask[action] = typeof global.isCallLegal === 'function'
                ? !!global.isCallLegal(history, call, actor)
                : true;
        }
        return mask;
    }

    async function gitBlobSha1(buffer) {
        if (!global.crypto || !global.crypto.subtle || typeof TextEncoder === 'undefined') return null;
        const prefix = new TextEncoder().encode(`blob ${buffer.byteLength}\0`);
        const bytes = new Uint8Array(prefix.byteLength + buffer.byteLength);
        bytes.set(prefix, 0);
        bytes.set(new Uint8Array(buffer), prefix.byteLength);
        const digest = await global.crypto.subtle.digest('SHA-1', bytes);
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }

    class PolicyModel {
        constructor(arrayBuffer) {
            this.data = new Float32Array(arrayBuffer);
            this.layers = COMMON_LAYERS;
            const expectedFloats = 3681319;
            if (this.data.length !== expectedFloats) {
                throw new Error(`BRL: poids invalides (${this.data.length} floats, attendu ${expectedFloats})`);
            }
        }

        dense(x, layer, relu) {
            const inDim = layer.w.shape[0];
            const outDim = layer.w.shape[1];
            const w = this.data;
            const out = new Float32Array(outDim);
            const wOff = layer.w.offset;
            const bOff = layer.b.offset;
            for (let j = 0; j < outDim; j++) out[j] = w[bOff + j];
            for (let i = 0; i < inDim; i++) {
                const xi = x[i];
                if (xi === 0) continue;
                const row = wOff + i * outDim;
                for (let j = 0; j < outDim; j++) out[j] += xi * w[row + j];
            }
            if (relu) {
                for (let j = 0; j < outDim; j++) if (out[j] < 0) out[j] = 0;
            }
            return out;
        }

        logits(obs) {
            let x = obs;
            for (let i = 0; i < 4; i++) x = this.dense(x, this.layers[i], true);
            return this.dense(x, this.layers[4], false);
        }

        policy(obs, legalMask) {
            const logits = this.logits(obs);
            let max = -Infinity;
            for (let a = 0; a < ACTION_COUNT; a++) {
                if (legalMask[a] && logits[a] > max) max = logits[a];
            }
            const probs = new Float32Array(ACTION_COUNT);
            let sum = 0;
            for (let a = 0; a < ACTION_COUNT; a++) {
                if (!legalMask[a]) continue;
                probs[a] = Math.exp(logits[a] - max);
                sum += probs[a];
            }
            if (!(sum > 0)) throw new Error('BRL: distribution de politique invalide');
            for (let a = 0; a < ACTION_COUNT; a++) probs[a] /= sum;
            return probs;
        }
    }

    async function fetchModelBytes(modelName) {
        const meta = MODELS[modelName];
        if (!meta) throw new Error(`BRL: modèle inconnu ${modelName}`);
        const url = `${RAW_BASE}/${meta.file}`;
        setStatus(`🧠 ${meta.label} : chargement du modèle (~14 Mo)…`, 'is-offline', modelName);
        const response = await fetch(url, { cache: 'force-cache', mode: 'cors' });
        if (!response.ok) throw new Error(`BRL: téléchargement ${meta.file} HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength !== meta.bytes) {
            throw new Error(`BRL: taille ${meta.file} invalide (${buffer.byteLength}, attendu ${meta.bytes})`);
        }
        const sha = await gitBlobSha1(buffer);
        if (sha && sha !== meta.gitBlobSha1) {
            throw new Error(`BRL: empreinte Git ${meta.file} invalide (${sha})`);
        }
        return buffer;
    }

    async function ensureReady(modelName) {
        const normalized = modelName === 'sl' ? 'sl' : 'rl-fsp';
        if (loadedModels.has(normalized)) {
            setStatus(`🧠 ${MODELS[normalized].label} : prêt`, 'is-online', normalized);
            return loadedModels.get(normalized);
        }
        if (loadingModels.has(normalized)) return loadingModels.get(normalized);
        const promise = (async () => {
            try {
                const buffer = await fetchModelBytes(normalized);
                const model = new PolicyModel(buffer);
                loadedModels.set(normalized, model);
                setStatus(`🧠 ${MODELS[normalized].label} : prêt`, 'is-online', normalized);
                return model;
            } catch (err) {
                setStatus(`⚠️ ${MODELS[normalized].label} : indisponible`, 'is-warning', normalized);
                throw err;
            } finally {
                loadingModels.delete(normalized);
            }
        })();
        loadingModels.set(normalized, promise);
        return promise;
    }

    async function decideRobotCallForApp(turnSeat, deal, history, options) {
        const modelName = options && options.model === 'sl' ? 'sl' : 'rl-fsp';
        const model = await ensureReady(modelName);
        if (!deal || !deal.hands || !deal.hands[turnSeat]) throw new Error(`BRL: main ${turnSeat} non disponible`);
        const hand = deal.hands[turnSeat];
        const obs = encodeObservation(hand, deal.dealer, deal.vulnerable, history, turnSeat);
        const legalMask = buildLegalMask(history, turnSeat);
        const probs = model.policy(obs, legalMask);
        const plausibleMask = buildPlausibilityMask(hand, history, turnSeat, legalMask);

        let rawBest = 0;
        for (let a = 1; a < ACTION_COUNT; a++) {
            if (legalMask[a] && probs[a] > probs[rawBest]) rawBest = a;
        }
        let best = 0;
        for (let a = 1; a < ACTION_COUNT; a++) {
            if (plausibleMask[a] && probs[a] > probs[best]) best = a;
        }
        const call = actionToCall(best) || 'PASS';
        const pct = Math.round(probs[best] * 100);
        const guarded = rawBest !== best;
        return {
            call,
            explanation: `${MODELS[modelName].label} · choix réseau ${pct}%${guarded ? ' · garde-fou cohérence' : ''}`,
            probability: probs[best],
            rawCall: actionToCall(rawBest),
            guardrailApplied: guarded,
            model: modelName
        };
    }

    function isReady(modelName) {
        const normalized = modelName === 'sl' ? 'sl' : 'rl-fsp';
        return loadedModels.has(normalized);
    }

    function diagnostic() {
        return {
            available: true,
            commit: MODEL_COMMIT,
            loaded: Array.from(loadedModels.keys()),
            loading: Array.from(loadingModels.keys()),
            models: Object.keys(MODELS)
        };
    }

    global.BrlEngine = Object.freeze({
        ensureReady,
        isReady,
        decideRobotCallForApp,
        modelNameFromEngine,
        diagnostic,
        // Hooks purs utiles au gate de régression ; ils ne mutent aucun état de PLAY.
        _test: Object.freeze({ actionToCall, callToAction, encodeObservation, buildLegalMask, handFacts, brlCallPlausible, buildPlausibilityMask, PolicyModel })
    });
})(typeof window !== 'undefined' ? window : globalThis);
