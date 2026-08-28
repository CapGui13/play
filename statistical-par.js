// statistical-par.js — logique pure du mode « PAR statistique » de PLAY.
//
// Principe de sécurité : une main appartenant à un siège randomisé n'est JAMAIS lue.
// R75 conserve la perspective de CAMP validée en R71. Avec un seul humain et un partenaire bot,
// les 26 cartes du camp (humain + partenaire bot) sont actées et seules les 26 cartes
// adverses sont redistribuées. Un siège PENDING reste en revanche inconnu jusqu'à ce qu'un
// vrai participant le revendique : on ne lit jamais secrètement la main d'un futur humain.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlayStatisticalPar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SEATS = ['N', 'E', 'S', 'W'];
    const SUITS = ['S', 'H', 'D', 'C'];
    const RANKS = 'AKQJT98765432';

    const STATISTICAL_PAR_ALGORITHM_VERSION = 'r102-optimal-contracts-side-fixed-24-public-conditioned';

    // R70 — l'optimisation porte uniquement sur le MOMENT où des tirages sont résolus.
    // Le sampler lui-même reste exactement celui de R66, rétabli par R68 après rejet de
    // l'ordonnanceur R67. Conserver ce sel prouve que sampleIndex -> donne virtuelle ne change
    // pas : aucune pondération, aucun réordonnancement et aucun biais de population.
    const STATISTICAL_PAR_SAMPLING_SEED_VERSION = 'r66-par-distribution-precision-v12-sync-lineage-conditioning-epoch-seat-perspective-stability-auction-lineage-dealerpar-adaptive-public';
    const REPRESENTATIVE_WINDOWS = Object.freeze([
        Object.freeze({ start: 0, size: 8 }),
        Object.freeze({ start: 8, size: 16 })
    ]);
    const representativeOrderCache = new Map();

    function xmur3(text) {
        let h = 1779033703 ^ String(text).length;
        for (let i = 0; i < String(text).length; i++) {
            h = Math.imul(h ^ String(text).charCodeAt(i), 3432918353);
            h = h << 13 | h >>> 19;
        }
        return function () {
            h = Math.imul(h ^ (h >>> 16), 2246822507);
            h = Math.imul(h ^ (h >>> 13), 3266489909);
            return (h ^= h >>> 16) >>> 0;
        };
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0;
            a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    function canonicalKnownCards(deal, config) {
        const seats = ((config && (config.knownSeats || config.humanSeats)) || []).slice().sort();
        return seats.map(seat => seat + ':' + SUITS.map(suit => String(deal && deal.hands && deal.hands[seat] && deal.hands[seat][suit] || '')).join('.')).join('|');
    }

    function deterministicSeedMaterial(deal, config, sampleIndex) {
        return [
            STATISTICAL_PAR_SAMPLING_SEED_VERSION,
            String(deal && deal.board != null ? deal.board : ''),
            String(deal && deal.dealer || ''),
            String(deal && deal.vulnerable || ''),
            String(config && config.mode || ''),
            canonicalKnownCards(deal, config),
            String(sampleIndex)
        ].join('~');
    }

    function deterministicRngForSample(deal, config, sampleIndex) {
        const seed = xmur3(deterministicSeedMaterial(deal, config, sampleIndex))();
        return mulberry32(seed);
    }

    function sideOfSeat(seat) {
        return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
    }

    // R78 — pour l'arrêt pratique, on distingue le contrat substantiel (niveau +
    // dénomination + camp) des détails de table DD (déclarant exact, +1/+2, sacrifice).
    // L'histogramme exact reste affiché ; cette famille sert uniquement à décider si
    // poursuivre des centaines de DDS apporte encore une information concrètement utile.
    function parFamilyFromContractOption(option) {
        if (option == null) return null;
        let opt = option;
        if (typeof opt === 'string') {
            const raw = String(opt);
            if (raw === 'pass') return { key: 'pass', raw: 'pass', passout: true, level: 0, strain: null, declarer: null, delta: 0 };
            const m = raw.match(/^([1-7])([CDHSN])(\*)?-(NS|EW|N|E|S|W)([+-]\d+)?$/);
            if (!m) return { key: raw, raw, passout: false };
            opt = { raw, passout: false, level: Number(m[1]), strain: m[2], declarer: m[4], doubled: m[3] || '', delta: m[5] ? Number(m[5]) : 0 };
        }
        if (opt.passout || opt.raw === 'pass') return { key: 'pass', raw: 'pass', passout: true, level: 0, strain: null, declarer: null, delta: 0 };
        const level = Number(opt.level);
        const strain = String(opt.strain || '');
        const declarer = String(opt.declarer || '');
        if (!Number.isInteger(level) || level < 1 || level > 7 || !/^[CDHSN]$/.test(strain)) {
            const raw = String(opt.raw || 'unknown');
            return { key: raw, raw, passout: false };
        }
        let side = declarer;
        if (/^(?:N|S|NS)$/.test(declarer)) side = 'NS';
        else if (/^(?:E|W|EW)$/.test(declarer)) side = 'EW';
        const delta = Number(opt.delta || 0);
        const doubled = String(opt.doubled || '');
        // Une chute/sacrifice contré reste une famille distincte d'un contrat fait. R78
        // regroupe seulement les overtricks positifs et le déclarant exact au sein du camp.
        const isSacrifice = delta < 0 || !!doubled;
        const key = isSacrifice
            ? `${level}${strain}${doubled || 'X'}-${side}${delta < 0 ? String(delta) : ''}`
            : `${level}${strain}-${side}`;
        return { key, raw: key, passout: false, level, strain, declarer: side, doubled: isSacrifice ? (doubled || 'X') : '', delta: isSacrifice ? delta : 0 };
    }

    function familyObservationFromContracts(contracts) {
        const rows = Array.isArray(contracts) ? contracts : [];
        if (!rows.length) return {};
        const out = {};
        const share = 1 / rows.length;
        for (const option of rows) {
            const family = parFamilyFromContractOption(option);
            if (!family || !family.key) continue;
            out[family.key] = Number(out[family.key] || 0) + share;
        }
        return out;
    }

    const PRACTICAL_ADAPTIVE_FAMILY_PROFILES = Object.freeze([
        Object.freeze({ name: 'fast', minSamples: 24, minLeaderShare: 0.70, minGap: 0.50, stabilityWindow: 12, maxScoreMargin95: 100 }),
        Object.freeze({ name: 'early', minSamples: 36, minLeaderShare: 0.60, minGap: 0.35, stabilityWindow: 18, maxScoreMargin95: 100 }),
        Object.freeze({ name: 'normal', minSamples: 48, minLeaderShare: 0.50, minGap: 0.25, stabilityWindow: 24, maxScoreMargin95: 100 }),
        Object.freeze({ name: 'standard', minSamples: 60, minLeaderShare: 0.45, minGap: 0.20, stabilityWindow: 30, maxScoreMargin95: 100 }),
        Object.freeze({ name: 'baseline', minSamples: 72, minLeaderShare: 0.40, minGap: 0.18, stabilityWindow: 36, maxScoreMargin95: 100 }),
        Object.freeze({ name: 'deep', minSamples: 120, minLeaderShare: 0.35, minGap: 0.15, stabilityWindow: 60, maxScoreMargin95: 90 }),
        Object.freeze({ name: 'deep2', minSamples: 192, minLeaderShare: 0.30, minGap: 0.12, stabilityWindow: 96, maxScoreMargin95: 80 })
    ]);
    const PRACTICAL_ADAPTIVE_SAFETY_MAX = 120;
    const PRACTICAL_ADAPTIVE_CHECKPOINT = 6;

    function familyDistributionAtPrefix(observations, n) {
        const limit = Math.max(0, Math.min(Number(n || 0), Array.isArray(observations) ? observations.length : 0));
        const counts = new Map();
        for (let i = 0; i < limit; i++) {
            const obs = observations[i] || {};
            for (const [key, weight] of Object.entries(obs)) {
                const w = Number(weight);
                if (!Number.isFinite(w) || w <= 0) continue;
                counts.set(key, Number(counts.get(key) || 0) + w);
            }
        }
        const denom = Math.max(1, limit);
        const rows = Array.from(counts.entries())
            .map(([key, count]) => ({ key, count, share: count / denom }))
            .sort((a, b) => b.share - a.share || String(a.key).localeCompare(String(b.key)));
        const leader = rows[0] || null;
        const runnerUp = rows[1] || null;
        return { n: limit, rows, leader, runnerUp, gap: leader ? leader.share - Number(runnerUp ? runnerUp.share : 0) : 0 };
    }

    function evaluatePracticalAdaptiveFamilyStop(observations, scoreMargin95, options = {}) {
        const rows = Array.isArray(observations) ? observations : [];
        const n = rows.length;
        const maxSamples = Number(options.maxSamples || PRACTICAL_ADAPTIVE_SAFETY_MAX);
        const current = familyDistributionAtPrefix(rows, n);
        const base = {
            done: false,
            converged: false,
            reason: null,
            profile: null,
            sampleCount: n,
            familyKey: current.leader && current.leader.key || null,
            familyShare: current.leader ? current.leader.share : 0,
            familyGap: current.gap,
            scoreMargin95: Number.isFinite(Number(scoreMargin95)) ? Number(scoreMargin95) : null
        };
        if (n < PRACTICAL_ADAPTIVE_FAMILY_PROFILES[0].minSamples || !current.leader) return base;
        if (n % PRACTICAL_ADAPTIVE_CHECKPOINT !== 0 && n < maxSamples) return base;

        for (const profile of PRACTICAL_ADAPTIVE_FAMILY_PROFILES) {
            if (n < profile.minSamples) continue;
            if (current.leader.share < profile.minLeaderShare || current.gap < profile.minGap) continue;
            if (!Number.isFinite(Number(scoreMargin95)) || Number(scoreMargin95) > profile.maxScoreMargin95) continue;
            const start = Math.max(PRACTICAL_ADAPTIVE_CHECKPOINT, n - profile.stabilityWindow);
            let stable = true;
            for (let k = start; k <= n; k += PRACTICAL_ADAPTIVE_CHECKPOINT) {
                const at = familyDistributionAtPrefix(rows, k);
                if (!at.leader || at.leader.key !== current.leader.key) { stable = false; break; }
            }
            if (!stable) continue;
            return { ...base, done: true, converged: true, reason: 'adaptive-family-stable', profile: profile.name };
        }

        if (n >= maxSamples) {
            return { ...base, done: true, converged: false, reason: 'safety-cap-uncertain', profile: 'safety-cap' };
        }
        return base;
    }

    // R79 — validation séquentielle anytime-valid (sous le modèle Monte-Carlo IID).
    //
    // Idée : chaque époque utilise un préfixe déjà observé UNIQUEMENT pour élire une famille
    // candidate et figer ses concurrents. Les observations FUTURES valident ensuite cette
    // candidate. Pour un concurrent c, X_i = poids(candidate) - poids(c) appartient à [-1,1].
    // Sous H0: E[X_i | passé] <= 0, le produit Π(1 + λ X_i), λ∈(0,1), est un e-processus
    // non négatif. Un mélange fini de λ reste un e-processus. La règle de Ville permet donc
    // de tester à n'importe quel instant sans pénalité liée au nombre de regards.
    //
    // Les familles non vues au début d'une époque sont regroupées dans OTHER. Prouver que la
    // candidate bat OTHER (masse totale) implique qu'elle bat chacune de ces familles prises
    // séparément. Bonferroni contrôle simultanément tous les concurrents d'une époque ; le
    // budget alpha est partagé entre les époques. Ainsi la probabilité d'une validation erronée
    // est <= alpha sur tout l'horizon, sous l'hypothèse IID/stationnaire des tirages Monte-Carlo.
    const ANYTIME_FAMILY_ALPHA = 0.05;
    const ANYTIME_FAMILY_EPOCH_STARTS = Object.freeze([24, 72, 144]);
    const ANYTIME_FAMILY_CHECKPOINT = 6;
    const ANYTIME_FAMILY_LAMBDAS = Object.freeze([0.025, 0.05, 0.075, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95]);
    const ANYTIME_OTHER_KEY = '__OTHER__';

    function logMeanExp(values) {
        const xs = Array.isArray(values) ? values : [];
        if (!xs.length) return -Infinity;
        const max = Math.max(...xs);
        if (!Number.isFinite(max)) return max;
        let sum = 0;
        for (const value of xs) sum += Math.exp(value - max);
        return max + Math.log(sum / xs.length);
    }

    function anytimeEpochEvidence(observations, start, end, alphaEpoch, lambdas) {
        const pilot = familyDistributionAtPrefix(observations, start);
        if (!pilot.leader || end <= start) return null;
        const candidateKey = pilot.leader.key;
        const knownCompetitors = pilot.rows.filter(row => row.key !== candidateKey).map(row => row.key);
        const frozenKeys = new Set([candidateKey, ...knownCompetitors]);
        const competitors = [...knownCompetitors, ANYTIME_OTHER_KEY];
        const logProducts = new Map(competitors.map(key => [key, lambdas.map(() => 0)]));

        for (let i = start; i < end; i++) {
            const obs = observations[i] || {};
            const candidateWeight = Number(obs[candidateKey] || 0);
            let otherWeight = 0;
            for (const [key, rawWeight] of Object.entries(obs)) {
                if (frozenKeys.has(key)) continue;
                const weight = Number(rawWeight);
                if (Number.isFinite(weight) && weight > 0) otherWeight += weight;
            }
            for (const competitorKey of competitors) {
                const competitorWeight = competitorKey === ANYTIME_OTHER_KEY
                    ? otherWeight
                    : Number(obs[competitorKey] || 0);
                const x = Math.max(-1, Math.min(1, candidateWeight - competitorWeight));
                const logs = logProducts.get(competitorKey);
                for (let j = 0; j < lambdas.length; j++) {
                    const factor = 1 + lambdas[j] * x;
                    logs[j] += Math.log(Math.max(Number.MIN_VALUE, factor));
                }
            }
        }

        const alphaPerCompetitor = alphaEpoch / Math.max(1, competitors.length);
        const logThreshold = Math.log(1 / alphaPerCompetitor);
        let minLogEvidence = Infinity;
        const evidence = [];
        let validated = true;
        for (const competitorKey of competitors) {
            const logE = logMeanExp(logProducts.get(competitorKey));
            minLogEvidence = Math.min(minLogEvidence, logE);
            const passed = logE >= logThreshold;
            if (!passed) validated = false;
            evidence.push({
                competitorKey,
                logE,
                eValue: logE < 700 ? Math.exp(logE) : Infinity,
                threshold: Math.exp(logThreshold),
                passed
            });
        }
        return {
            start,
            validationSamples: end - start,
            candidateKey,
            knownCompetitorCount: knownCompetitors.length,
            competitorCount: competitors.length,
            alphaEpoch,
            alphaPerCompetitor,
            logThreshold,
            minLogEvidence,
            minEValue: minLogEvidence < 700 ? Math.exp(minLogEvidence) : Infinity,
            threshold: Math.exp(logThreshold),
            validated,
            evidence
        };
    }

    function evaluateAnytimeValidatedFamilyStop(observations, options = {}) {
        const rows = Array.isArray(observations) ? observations : [];
        const n = rows.length;
        const maxSamples = Number(options.maxSamples || PRACTICAL_ADAPTIVE_SAFETY_MAX);
        const alpha = Number.isFinite(Number(options.alpha)) && Number(options.alpha) > 0 && Number(options.alpha) < 1
            ? Number(options.alpha)
            : ANYTIME_FAMILY_ALPHA;
        const starts = (Array.isArray(options.epochStarts) && options.epochStarts.length
            ? options.epochStarts
            : ANYTIME_FAMILY_EPOCH_STARTS).map(Number).filter(x => Number.isInteger(x) && x > 0 && x < maxSamples);
        const lambdas = (Array.isArray(options.lambdas) && options.lambdas.length
            ? options.lambdas
            : ANYTIME_FAMILY_LAMBDAS).map(Number).filter(x => Number.isFinite(x) && x > 0 && x < 1);
        const current = familyDistributionAtPrefix(rows, n);
        const base = {
            done: false,
            converged: false,
            formallyValidated: false,
            reason: null,
            method: 'split-epoch-mixture-eprocess',
            sampleCount: n,
            alpha,
            confidencePct: (1 - alpha) * 100,
            familyKey: current.leader && current.leader.key || null,
            familyShare: current.leader ? current.leader.share : 0,
            familyGap: current.gap,
            epoch: null,
            minEValue: null,
            threshold: null
        };
        if (!starts.length || !lambdas.length || n < starts[0]) return base;
        if (n % ANYTIME_FAMILY_CHECKPOINT !== 0 && n < maxSamples) return base;

        const alphaEpoch = alpha / starts.length;
        for (const start of starts) {
            if (n <= start) continue;
            const epoch = anytimeEpochEvidence(rows, start, n, alphaEpoch, lambdas);
            if (!epoch || !epoch.validated) continue;
            return {
                ...base,
                done: true,
                converged: true,
                formallyValidated: true,
                reason: 'anytime-family-validated',
                familyKey: epoch.candidateKey,
                epoch: epoch.start,
                validationSamples: epoch.validationSamples,
                minEValue: epoch.minEValue,
                threshold: epoch.threshold,
                competitorCount: epoch.competitorCount
            };
        }
        if (n >= maxSamples) {
            return { ...base, done: true, converged: false, formallyValidated: false, reason: 'safety-cap-uncertain' };
        }
        return base;
    }

    function partnerOf(seat) {
        return { N: 'S', S: 'N', E: 'W', W: 'E' }[seat] || null;
    }

    function validateHumanVsBots(seatAssignment, pendingToken = 'PENDING') {
        const assignment = seatAssignment || {};
        const actualHumanSeats = SEATS.filter(seat => assignment[seat] != null && assignment[seat] !== pendingToken);
        const pendingSeats = SEATS.filter(seat => assignment[seat] === pendingToken);
        const reservedHumanSeats = SEATS.filter(seat => assignment[seat] != null);

        // Frontière d'information R47 : un siège PENDING est une place réservée à un futur
        // humain, PAS une main déjà connue. Ses 13 cartes doivent donc rester dans le pool
        // aléatoire tant qu'un vrai participant n'a pas revendiqué ce siège. C'est crucial
        // en mode différé : le host ne doit jamais bénéficier des cartes du partenaire absent.
        if (actualHumanSeats.length === 0) {
            return { ok: false, reason: 'Le mode PAR statistique exige au moins un siège humain réellement présent.' };
        }
        if (reservedHumanSeats.length > 2) {
            return { ok: false, reason: 'Le mode PAR statistique accepte un camp humain (un ou deux sièges partenaires), pas trois ou quatre sièges humains.' };
        }
        if (reservedHumanSeats.length === 2 && partnerOf(reservedHumanSeats[0]) !== reservedHumanSeats[1]) {
            return { ok: false, reason: 'Les deux sièges humains ou réservés doivent être partenaires (Nord-Sud ou Est-Ouest).' };
        }
        if (actualHumanSeats.length === 2 && partnerOf(actualHumanSeats[0]) !== actualHumanSeats[1]) {
            return { ok: false, reason: 'Les deux sièges humains doivent être partenaires (Nord-Sud ou Est-Ouest).' };
        }

        // R71 — perspective de CAMP : si un seul humain est présent et que son partenaire
        // est réellement un bot (siège non assigné), la main du partenaire fait partie des
        // 26 cartes actées du camp. C'est volontaire : on estime l'incertitude sur les deux
        // mains ADVERSES, pas sur une main partenaire que PLAY connaît et contrôle déjà.
        // Un partenaire PENDING reste au contraire inconnu jusqu'à sa revendication (R47).
        const humanSeats = actualHumanSeats.slice();
        const loneHumanSeat = actualHumanSeats.length === 1 ? actualHumanSeats[0] : null;
        const partnerSeat = loneHumanSeat ? partnerOf(loneHumanSeat) : null;
        const fixedBotPartnerSeat = partnerSeat && assignment[partnerSeat] == null ? partnerSeat : null;
        const knownSeatSet = new Set(actualHumanSeats);
        if (fixedBotPartnerSeat) knownSeatSet.add(fixedBotPartnerSeat);
        const knownSeats = SEATS.filter(seat => knownSeatSet.has(seat));
        const mode = knownSeats.length === 2 ? 'two-known-hands' : 'single-known-hand';
        const humanSide = sideOfSeat(actualHumanSeats[0]);
        if (reservedHumanSeats.some(seat => sideOfSeat(seat) !== humanSide)) {
            return { ok: false, reason: 'Tous les sièges humains ou réservés doivent appartenir au même camp.' };
        }
        const randomizedSeats = SEATS.filter(seat => !knownSeats.includes(seat));
        const botSeats = SEATS.filter(seat => assignment[seat] == null);
        const controlledByOneHuman = actualHumanSeats.length === 2
            && assignment[actualHumanSeats[0]] === assignment[actualHumanSeats[1]];

        return {
            ok: true,
            mode,
            knownSeats,
            humanSeats,
            actualHumanSeats,
            pendingSeats,
            reservedHumanSeats,
            randomizedSeats,
            botSeats,
            humanSide,
            botSide: humanSide === 'NS' ? 'EW' : 'NS',
            controlledByOneHuman,
            fixedBotPartnerSeat
        };
    }



    function handHcp(hand) {
        let total = 0;
        const points = { A: 4, K: 3, Q: 2, J: 1 };
        for (const suit of SUITS) {
            for (const rank of String(hand && hand[suit] || '')) total += points[rank] || 0;
        }
        return total;
    }

    function handProfile(hand) {
        return {
            hcp: handHcp(hand),
            lengths: {
                C: String(hand && hand.C || '').length,
                D: String(hand && hand.D || '').length,
                H: String(hand && hand.H || '').length,
                S: String(hand && hand.S || '').length
            }
        };
    }

    function profilesForSeats(hands, seats) {
        const out = {};
        for (const seat of (seats || [])) out[seat] = handProfile(hands && hands[seat]);
        return out;
    }

    // R89 — pons_infer_hulls() renvoie quatre joueurs dans l'ordre circulaire ANCRÉ
    // sur le prochain joueur à parler après la séquence fournie, et non sur le donneur.
    // Exemple : donneur Est, cinq calls E-S-O-N-E => le prochain joueur est Sud ;
    // announced[0..3] correspondent donc à S-O-N-E. R35–R88 les rattachaient à
    // E-S-O-N, ce qui pouvait appliquer un 5+♠ de Sud à Est et fausser toute la
    // population Monte-Carlo. `auctionCallCount` rétablit l'alignement exact.
    // Les longueurs PONS restent dans l'ordre C/D/H/S. Cette conversion ne consulte
    // AUCUNE main cachée.
    function publicConstraintsFromPonsInference(inference, dealer, auctionCallCount = 0) {
        const src = inference && (Array.isArray(inference.announced) ? inference.announced : inference.players);
        if (!Array.isArray(src) || src.length < 4) return null;
        const dealerIndex = Math.max(0, SEATS.indexOf(String(dealer || 'N').toUpperCase()));
        const callCount = Math.max(0, Number.isFinite(Number(auctionCallCount)) ? Math.trunc(Number(auctionCallCount)) : 0);
        const nextActorIndex = (dealerIndex + callCount) % 4;
        const suitOrder = ['C', 'D', 'H', 'S'];
        const out = {};
        for (let i = 0; i < 4; i++) {
            const seat = SEATS[(nextActorIndex + i) % 4];
            const row = src[i] || {};
            const hcp = row.hcp || {};
            const lengths = {};
            const rawLengths = Array.isArray(row.lengths) ? row.lengths : [];
            suitOrder.forEach((suit, j) => {
                const r = rawLengths[j] || {};
                lengths[suit] = {
                    min: Number.isFinite(Number(r.min)) ? Number(r.min) : 0,
                    max: Number.isFinite(Number(r.max)) ? Number(r.max) : 13
                };
            });
            out[seat] = {
                hcp: {
                    min: Number.isFinite(Number(hcp.min)) ? Number(hcp.min) : 0,
                    max: Number.isFinite(Number(hcp.max)) ? Number(hcp.max) : 37
                },
                lengths
            };
        }
        return out;
    }

    function profileMatchesConstraint(profile, constraint) {
        if (!profile || !constraint) return true;
        const hcp = Number(profile.hcp);
        const hmin = Number(constraint.hcp && constraint.hcp.min);
        const hmax = Number(constraint.hcp && constraint.hcp.max);
        if (Number.isFinite(hmin) && hcp < hmin) return false;
        if (Number.isFinite(hmax) && hcp > hmax) return false;
        for (const suit of ['C', 'D', 'H', 'S']) {
            const n = Number(profile.lengths && profile.lengths[suit]);
            const r = constraint.lengths && constraint.lengths[suit];
            if (!r) continue;
            const lo = Number(r.min), hi = Number(r.max);
            if (Number.isFinite(lo) && n < lo) return false;
            if (Number.isFinite(hi) && n > hi) return false;
        }
        return true;
    }

    function profilesMatchPublicConstraints(profiles, config, constraints) {
        if (!constraints) return true;
        const seats = (config && config.randomizedSeats) || [];
        return seats.every(seat => profileMatchesConstraint(profiles && profiles[seat], constraints[seat]));
    }

    function constraintsAreInformative(config, constraints) {
        if (!constraints || !config) return false;
        return (config.randomizedSeats || []).some(seat => {
            const c = constraints[seat];
            if (!c) return false;
            if (Number(c.hcp && c.hcp.min) > 0 || Number(c.hcp && c.hcp.max) < 37) return true;
            return ['C','D','H','S'].some(s => Number(c.lengths && c.lengths[s] && c.lengths[s].min) > 0 || Number(c.lengths && c.lengths[s] && c.lengths[s].max) < 13);
        });
    }

    // R48 — une estimation affichée ne doit jamais être une population hybride.
    // Pendant que le rejet PONS n'a pas encore produit assez de cas compatibles, on
    // affiche UNIQUEMENT les tirages bruts. Au seuil, on bascule d'un bloc vers la
    // population conditionnée. En fallback, les anciens tirages conditionnés sont exclus
    // par sécurité même si une migration imparfaite en avait laissé dans le job.
    function isConditionedEntry(entry) {
        return String(entry && entry.selectionMode || '').indexOf('conditioned') === 0;
    }

    // R56 — une table obtenue par rejet sous un ancien état de contraintes PONS n'est
    // réutilisable QUE si la signature de conditionnement est strictement identique.
    // Les hulls PONS ne sont pas garantis monotones au fil des enchères (un simple Passe
    // peut par exemple élargir une plage précédemment contrainte). Les tables brutes, elles,
    // restent i.i.d. et peuvent être refiltrées sous n'importe quel état public ultérieur.
    function selectConditioningPopulation(entries, config, conditioning, options = {}) {
        const all = Array.isArray(entries) ? entries : [];
        const minDisplay = Math.max(1, Number(options.minConditionedDisplay || 16));
        const fallbackKeys = options.fallbackKeys instanceof Set
            ? options.fallbackKeys
            : new Set(Array.isArray(options.fallbackKeys) ? options.fallbackKeys : []);
        const currentKey = conditioning && conditioning.informative ? String(conditioning.key || '') : 'raw';
        const rawOnly = all.filter(entry => !isConditionedEntry(entry));
        if (!conditioning || !conditioning.informative) {
            return { entries: rawOnly, compatible: rawOnly.length, conditioned: false, conditioningPending: false, conditioningFallback: false };
        }
        const eligible = all.filter(entry => !isConditionedEntry(entry) || String(entry && entry.conditioningKey || '') === currentKey);
        const compatible = eligible.filter(entry => profilesMatchPublicConstraints(entry && entry.profiles, config, conditioning.constraints));
        if (fallbackKeys.has(conditioning.key)) {
            return { entries: rawOnly, compatible: compatible.length, conditioned: false, conditioningPending: false, conditioningFallback: true };
        }
        if (compatible.length >= minDisplay) {
            return { entries: compatible, compatible: compatible.length, conditioned: true, conditioningPending: false, conditioningFallback: false };
        }
        return { entries: rawOnly, compatible: compatible.length, conditioned: false, conditioningPending: true, conditioningFallback: false };
    }

    function standardDeck() {
        const deck = [];
        for (const suit of SUITS) for (const rank of RANKS) deck.push(suit + rank);
        return deck;
    }

    function cardsFromHand(hand) {
        const cards = [];
        for (const suit of SUITS) {
            const ranks = String(hand && hand[suit] || '');
            for (const rank of ranks) cards.push(suit + rank);
        }
        return cards;
    }

    function remainingDeckFromHumanHands(deal, knownSeats) {
        if (!deal || !deal.hands) throw new Error('Donne invalide : mains absentes.');
        if (!Array.isArray(knownSeats) || (knownSeats.length !== 1 && knownSeats.length !== 2)) {
            throw new Error('Une ou deux mains connues sont requises.');
        }
        const seen = new Set();
        for (const seat of knownSeats) {
            const cards = cardsFromHand(deal.hands[seat]);
            if (cards.length !== 13) throw new Error(`Main connue ${seat} invalide : ${cards.length} cartes.`);
            for (const card of cards) {
                if (seen.has(card)) throw new Error(`Carte connue dupliquée : ${card}.`);
                seen.add(card);
            }
        }
        const remaining = standardDeck().filter(card => !seen.has(card));
        const expected = 52 - 13 * knownSeats.length;
        if (remaining.length !== expected) throw new Error(`Paquet résiduel invalide : ${remaining.length} cartes.`);
        return remaining;
    }

    function shuffledCopy(cards, rng = Math.random) {
        const out = cards.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const r = Number(rng());
            const bounded = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.9999999999999999) : 0;
            const j = Math.floor(bounded * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    function handFromCards(cards) {
        const bySuit = { S: '', H: '', D: '', C: '' };
        const rankIndex = Object.fromEntries(Array.from(RANKS).map((r, i) => [r, i]));
        for (const card of cards) {
            const suit = card[0];
            const rank = card.slice(1);
            if (!SUITS.includes(suit) || rankIndex[rank] == null) throw new Error(`Carte invalide : ${card}`);
            bySuit[suit] += rank;
        }
        for (const suit of SUITS) {
            bySuit[suit] = Array.from(bySuit[suit]).sort((a, b) => rankIndex[a] - rankIndex[b]).join('');
        }
        return bySuit;
    }

    function sampleHandsFromHumanHands(deal, config, rng = Math.random) {
        if (!config || !config.ok) throw new Error('Configuration PAR statistique invalide.');
        const knownSeats = Array.isArray(config.knownSeats) ? config.knownSeats : config.humanSeats;
        const randomizedSeats = Array.isArray(config.randomizedSeats)
            ? config.randomizedSeats
            : SEATS.filter(seat => !knownSeats.includes(seat));
        const pool = shuffledCopy(remainingDeckFromHumanHands(deal, knownSeats), rng);
        if (pool.length !== randomizedSeats.length * 13) {
            throw new Error('Répartition statistique incompatible avec le nombre de sièges inconnus.');
        }
        const hands = {};
        // Copie UNIQUEMENT les mains connues. Aucune main réellement distribuée à un
        // siège randomisé n'est consultée, y compris le partenaire bot en mode 1 humain.
        for (const seat of knownSeats) hands[seat] = { ...deal.hands[seat] };
        randomizedSeats.forEach((seat, index) => {
            hands[seat] = handFromCards(pool.slice(index * 13, (index + 1) * 13));
        });
        return hands;
    }

    function sampleHandsBaseDeterministic(deal, config, sourceIndex) {
        return sampleHandsFromHumanHands(deal, config, deterministicRngForSample(deal, config, sourceIndex));
    }

    function randomizedSeatOrder(config) {
        const set = new Set((config && config.randomizedSeats) || []);
        return SEATS.filter(seat => set.has(seat));
    }

    function cardOwnerAmongSeats(hands, card, seats) {
        const suit = String(card || '')[0];
        const rank = String(card || '').slice(1);
        for (const seat of seats || []) {
            if (String(hands && hands[seat] && hands[seat][suit] || '').includes(rank)) return seat;
        }
        return null;
    }

    // R67 — dimensions purement combinatoires utilisées pour REORDONNER une fenêtre déjà
    // tirée uniformément. Elles ne donnent aucun poids aux résultats DDS/DealerPar.
    //  - longueur de chaque couleur dans les sièges inconnus : capte 4-2, 3-3, 5-1, etc. ;
    //  - propriétaire de chaque honneur encore caché A/K/Q/J ;
    //  - même main / mains séparées pour chaque paire d'honneurs cachés d'une couleur.
    // L'absence de toute lecture d'une vraie main randomisée est structurelle : `hands` est
    // ici une DONNE VIRTUELLE issue du sampler, et les honneurs déjà connus sont déterminés
    // uniquement depuis les sièges de config.knownSeats.
    function representativeFeatureMap(deal, config, hands) {
        const seats = randomizedSeatOrder(config);
        const knownSeats = (config && (config.knownSeats || config.humanSeats)) || [];
        const knownCards = new Set();
        for (const seat of knownSeats) {
            for (const card of cardsFromHand(deal && deal.hands && deal.hands[seat])) knownCards.add(card);
        }
        const features = new Map();
        for (const suit of SUITS) {
            const tuple = seats.map(seat => String(hands && hands[seat] && hands[seat][suit] || '').length).join('-');
            features.set(`length:${suit}`, tuple);

            const hiddenHonors = [];
            for (const rank of 'AKQJ') {
                const card = suit + rank;
                if (knownCards.has(card)) continue;
                const owner = cardOwnerAmongSeats(hands, card, seats);
                if (!owner) continue;
                hiddenHonors.push({ rank, owner });
                features.set(`honor:${card}`, owner);
            }
            for (let i = 0; i < hiddenHonors.length; i++) {
                for (let j = i + 1; j < hiddenHonors.length; j++) {
                    const a = hiddenHonors[i], b = hiddenHonors[j];
                    features.set(`pair:${suit}${a.rank}${b.rank}`, a.owner === b.owner ? 'same' : 'split');
                }
            }
        }
        return features;
    }

    function representativeDimensionWeight(name) {
        if (String(name).startsWith('length:')) return 4;
        if (String(name).startsWith('pair:')) return 2;
        if (String(name).startsWith('honor:')) return 1;
        return 1;
    }

    function combination(n, k) {
        let nn = Math.floor(Number(n)), kk = Math.floor(Number(k));
        if (!Number.isFinite(nn) || !Number.isFinite(kk) || kk < 0 || kk > nn) return 0;
        kk = Math.min(kk, nn - kk);
        let out = 1;
        for (let i = 1; i <= kk; i++) out = out * (nn - kk + i) / i;
        return out;
    }

    function lengthTupleProbabilities(missingCards, seatCount) {
        const missing = Math.max(0, Math.floor(Number(missingCards) || 0));
        const seats = Math.max(1, Math.floor(Number(seatCount) || 1));
        const denominator = combination(13 * seats, missing);
        const out = new Map();
        const tuple = new Array(seats).fill(0);
        function walk(index, left, ways) {
            if (index === seats - 1) {
                if (left < 0 || left > 13) return;
                tuple[index] = left;
                const w = ways * combination(13, left);
                out.set(tuple.join('-'), denominator ? w / denominator : 0);
                return;
            }
            const min = Math.max(0, left - 13 * (seats - index - 1));
            const max = Math.min(13, left);
            for (let n = min; n <= max; n++) {
                tuple[index] = n;
                walk(index + 1, left - n, ways * combination(13, n));
            }
        }
        walk(0, missing, 1);
        return out;
    }

    function representativeTheoreticalDimensions(deal, config) {
        const seats = randomizedSeatOrder(config);
        const seatCount = seats.length;
        const knownSeats = (config && (config.knownSeats || config.humanSeats)) || [];
        const knownCards = new Set();
        for (const seat of knownSeats) {
            for (const card of cardsFromHand(deal && deal.hands && deal.hands[seat])) knownCards.add(card);
        }
        const dimensions = new Map();
        if (!seatCount) return dimensions;

        for (const suit of SUITS) {
            let knownSuitCards = 0;
            for (const seat of knownSeats) knownSuitCards += String(deal && deal.hands && deal.hands[seat] && deal.hands[seat][suit] || '').length;
            const missing = 13 - knownSuitCards;
            dimensions.set(`length:${suit}`, lengthTupleProbabilities(missing, seatCount));

            const hiddenHonors = [];
            for (const rank of 'AKQJ') {
                const card = suit + rank;
                if (knownCards.has(card)) continue;
                hiddenHonors.push(rank);
                dimensions.set(`honor:${card}`, new Map(seats.map(seat => [seat, 1 / seatCount])));
            }
            for (let i = 0; i < hiddenHonors.length; i++) {
                for (let j = i + 1; j < hiddenHonors.length; j++) {
                    // Deux cartes distinctes occupent deux des 13*r emplacements inconnus.
                    // Une fois la première placée, 12 emplacements de sa main sur 13*r-1
                    // gardent la seconde dans la même main. Pour deux mains : 48% même
                    // main / 52% séparées (la règle pédagogique 25/25/50 est l'arrondi
                    // indépendant, alors que PLAY respecte ici la combinatoire exacte).
                    const pSame = seatCount > 0 ? 12 / (13 * seatCount - 1) : 0;
                    dimensions.set(`pair:${suit}${hiddenHonors[i]}${hiddenHonors[j]}`, new Map([
                        ['same', pSame],
                        ['split', 1 - pSame]
                    ]));
                }
            }
        }
        return dimensions;
    }

    function representativePoolModel(candidates, deal, config) {
        const rows = candidates.map(candidate => ({
            candidate,
            features: representativeFeatureMap(deal, config, candidate.hands)
        }));
        const dimensions = representativeTheoreticalDimensions(deal, config);
        return { rows, dimensions };
    }

    function representativeDiscrepancy(model, prefixRows, step) {
        const prefixCounts = new Map();
        for (const row of prefixRows) {
            for (const [name, outcome] of row.features) {
                if (!prefixCounts.has(name)) prefixCounts.set(name, new Map());
                const counts = prefixCounts.get(name);
                counts.set(outcome, (counts.get(outcome) || 0) + 1);
            }
        }
        let total = 0;
        let totalWeight = 0;
        for (const [name, probabilities] of model.dimensions) {
            const weight = representativeDimensionWeight(name);
            let dimensionError = 0;
            const observed = prefixCounts.get(name) || new Map();
            for (const [outcome, probability] of probabilities) {
                const target = probability * step;
                const actual = observed.get(outcome) || 0;
                const delta = actual - target;
                dimensionError += delta * delta;
            }
            dimensionError /= Math.max(1, probabilities.size);
            total += weight * dimensionError;
            totalWeight += weight;
        }
        return totalWeight ? total / totalWeight : 0;
    }

    function orderCandidatesRepresentative(candidates, deal, config, prefixCandidates = []) {
        const source = Array.isArray(candidates) ? candidates.slice() : [];
        if (source.length <= 1) return source;
        const prefix = Array.isArray(prefixCandidates) ? prefixCandidates.slice() : [];
        // Le modèle théorique ne dépend pas du pool, mais les rows oui. Inclure le préfixe
        // déjà réellement planifié permet à la fenêtre 9..24 de COMPENSER les écarts du
        // socle 1..8 au lieu de repartir artificiellement de zéro.
        const model = representativePoolModel(prefix.concat(source), deal, config);
        const rowBySourceIndex = new Map(model.rows.map(row => [row.candidate.sourceIndex, row]));
        const remaining = source.map(candidate => rowBySourceIndex.get(candidate.sourceIndex));
        const fixedPrefixRows = prefix.map(candidate => rowBySourceIndex.get(candidate.sourceIndex)).filter(Boolean);
        const chosen = [];
        while (remaining.length) {
            const step = fixedPrefixRows.length + chosen.length + 1;
            let bestIndex = 0;
            let bestScore = Infinity;
            let bestSourceIndex = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                const row = remaining[i];
                const score = representativeDiscrepancy(model, fixedPrefixRows.concat(chosen, row), step);
                const sourceIndex = Number(row.candidate && row.candidate.sourceIndex);
                const tie = Number.isFinite(sourceIndex) ? sourceIndex : i;
                if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && tie < bestSourceIndex)) {
                    bestIndex = i;
                    bestScore = score;
                    bestSourceIndex = tie;
                }
            }
            chosen.push(remaining.splice(bestIndex, 1)[0]);
        }
        return chosen.map(row => row.candidate);
    }

    function representativeWindowForIndex(sampleIndex) {
        const index = Number(sampleIndex);
        return REPRESENTATIVE_WINDOWS.find(w => index >= w.start && index < w.start + w.size) || null;
    }

    function representativeOrderCacheKey(deal, config, window) {
        return [
            STATISTICAL_PAR_SAMPLING_SEED_VERSION,
            String(deal && deal.board != null ? deal.board : ''),
            String(deal && deal.dealer || ''),
            String(deal && deal.vulnerable || ''),
            String(config && config.mode || ''),
            canonicalKnownCards(deal, config),
            randomizedSeatOrder(config).join(''),
            `${window.start}:${window.size}`
        ].join('~');
    }

    function representativeSampleOrder(deal, config, start, size) {
        const window = { start: Number(start), size: Number(size) };
        const key = representativeOrderCacheKey(deal, config, window);
        const cached = representativeOrderCache.get(key);
        if (cached) return cached.slice();
        const candidates = [];
        for (let sourceIndex = window.start; sourceIndex < window.start + window.size; sourceIndex++) {
            candidates.push({ sourceIndex, hands: sampleHandsBaseDeterministic(deal, config, sourceIndex) });
        }
        const prefixCandidates = [];
        for (const previous of REPRESENTATIVE_WINDOWS) {
            if (previous.start >= window.start) break;
            const previousOrder = representativeSampleOrder(deal, config, previous.start, previous.size);
            for (const sourceIndex of previousOrder) {
                prefixCandidates.push({ sourceIndex, hands: sampleHandsBaseDeterministic(deal, config, sourceIndex) });
            }
        }
        const order = orderCandidatesRepresentative(candidates, deal, config, prefixCandidates).map(c => c.sourceIndex);
        representativeOrderCache.set(key, order.slice());
        // Les fenêtres sont minuscules (8 et 16). Une borne défensive évite toutefois qu'un
        // très long import multi-séances fasse croître ce cache sans limite.
        if (representativeOrderCache.size > 512) representativeOrderCache.delete(representativeOrderCache.keys().next().value);
        return order;
    }

    function representativeSourceIndex(deal, config, sampleIndex) {
        // R68 — R67 est REJETÉ par benchmark DDS réel : la micro-stratification
        // combinatoire améliorait les longueurs/honneurs mais dégradait en moyenne
        // l'histogramme DealerPar précoce. On revient donc au tirage R66 exact.
        return Number(sampleIndex);
    }

    function sampleHandsDeterministic(deal, config, sampleIndex) {
        const sourceIndex = representativeSourceIndex(deal, config, sampleIndex);
        return sampleHandsBaseDeterministic(deal, config, sourceIndex);
    }

    // Diagnostic/test R67 : mesure la distance d'un préfixe à la composition complète de
    // sa fenêtre, avec exactement les mêmes dimensions/poids que l'ordonnanceur.
    function representativePrefixDiscrepancy(deal, config, orderedSourceIndices, prefixLength, referenceSourceIndices) {
        const reference = (referenceSourceIndices || orderedSourceIndices || []).map(sourceIndex => ({
            sourceIndex,
            hands: sampleHandsBaseDeterministic(deal, config, sourceIndex)
        }));
        const model = representativePoolModel(reference, deal, config);
        // Ne pas utiliser Set pour reconstruire l'ordre : deux indices sont uniques, mais le
        // préfixe doit conserver exactement la séquence demandée.
        const byIndex = new Map(model.rows.map(row => [row.candidate.sourceIndex, row]));
        const prefixRows = (orderedSourceIndices || []).slice(0, Math.max(0, Number(prefixLength) || 0)).map(i => byIndex.get(i)).filter(Boolean);
        return representativeDiscrepancy(model, prefixRows, prefixRows.length);
    }

    function countCardsInHands(hands) {
        const cards = [];
        for (const seat of SEATS) cards.push(...cardsFromHand(hands && hands[seat]));
        return cards;
    }

    return {
        SEATS,
        SUITS,
        RANKS,
        sideOfSeat,
        partnerOf,
        validateHumanVsBots,
        standardDeck,
        cardsFromHand,
        remainingDeckFromHumanHands,
        shuffledCopy,
        handFromCards,
        sampleHandsFromHumanHands,
        sampleHandsBaseDeterministic,
        sampleHandsDeterministic,
        representativeFeatureMap,
        combination,
        lengthTupleProbabilities,
        representativeTheoreticalDimensions,
        orderCandidatesRepresentative,
        representativeSampleOrder,
        representativeSourceIndex,
        representativePrefixDiscrepancy,
        deterministicRngForSample,
        deterministicSeedMaterial,
        STATISTICAL_PAR_ALGORITHM_VERSION,
        STATISTICAL_PAR_SAMPLING_SEED_VERSION,
        PRACTICAL_ADAPTIVE_FAMILY_PROFILES,
        PRACTICAL_ADAPTIVE_SAFETY_MAX,
        PRACTICAL_ADAPTIVE_CHECKPOINT,
        ANYTIME_FAMILY_ALPHA,
        ANYTIME_FAMILY_EPOCH_STARTS,
        ANYTIME_FAMILY_CHECKPOINT,
        ANYTIME_FAMILY_LAMBDAS,
        parFamilyFromContractOption,
        familyObservationFromContracts,
        familyDistributionAtPrefix,
        evaluatePracticalAdaptiveFamilyStop,
        evaluateAnytimeValidatedFamilyStop,
        countCardsInHands,
        handHcp,
        handProfile,
        profilesForSeats,
        publicConstraintsFromPonsInference,
        profileMatchesConstraint,
        profilesMatchPublicConstraints,
        constraintsAreInformative,
        selectConditioningPopulation,
        isConditionedEntry
    };
});
