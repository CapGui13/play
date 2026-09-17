// R141 — persistance progressive + préchauffage conditionné pendant l'enchère.
// Chargé après app.js ; ne modifie ni le moteur statistique ni les règles PONS.
(function () {
    'use strict';

    const RESUME_VERSION = 1;
    const SAVE_THROTTLE_MS = 2500;
    const PREWARM_POLL_MS = 350;
    const hydratedDeals = new WeakSet();
    const lastSavedAt = new WeakMap();
    const lastSavedFingerprint = new WeakMap();
    const lastAuctionSignature = new WeakMap();

    function finiteInt(value, min, max) {
        const n = Number(value);
        if (!Number.isInteger(n)) return null;
        if (n < min || n > max) return null;
        return n;
    }

    function validTricks(value) {
        const n = Number(value);
        return Number.isInteger(n) && n >= 0 && n <= 13 ? n : null;
    }

    function serializeEntries(map, valueSerializer) {
        if (!(map instanceof Map)) return [];
        const rows = [];
        for (const [sampleIndex, value] of map.entries()) {
            const idx = finiteInt(sampleIndex, 0, 1000);
            if (idx === null) continue;
            const serialized = valueSerializer(value, idx);
            if (serialized !== null && serialized !== undefined) rows.push([idx, serialized]);
        }
        rows.sort((a, b) => a[0] - b[0]);
        return rows;
    }

    function serializeDealResume(deal) {
        if (!deal) return null;
        let signature = '';
        try { signature = statisticalParAuctionSignature(deal); } catch (_) { return null; }

        const resume = {
            version: RESUME_VERSION,
            auctionSignature: signature,
            samplingSeedVersion: (window.PlayStatisticalPar && window.PlayStatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION) || '',
            savedAt: Date.now(),
            fast: null,
            direct: [],
            generic: null
        };

        try {
            const fast = contractChanceFastPrimaryState(deal, false);
            if (fast && fast.key) {
                resume.fast = {
                    key: String(fast.key || ''),
                    target: fast.target ? { ...fast.target } : null,
                    declarer: String(fast.declarer || ''),
                    failures: Number(fast.failures || 0),
                    entries: serializeEntries(fast.entries, value => validTricks(value))
                };
            }
        } catch (_) {}

        try {
            const direct = contractChanceDirectStateMap(deal, false);
            if (direct instanceof Map) {
                for (const state of direct.values()) {
                    if (!state || !state.cell || !state.key) continue;
                    resume.direct.push({
                        key: String(state.key || ''),
                        cell: { ...state.cell },
                        planKey: String(state.planKey || ''),
                        failures: Number(state.failures || 0),
                        adaptiveTarget: Number(state.adaptiveTarget || CONTRACT_CHANCE_TARGET),
                        adaptiveSettled: !!state.adaptiveSettled,
                        entries: serializeEntries(state.entries, value => validTricks(value))
                    });
                }
            }
        } catch (_) {}

        // Le chemin générique conserve les tables DD déjà calculées. C'est plus volumineux
        // que fast/direct, mais cela évite de refaire ces DDS après un refresh lorsqu'un PAR
        // secondaire en dépend. On ne persiste jamais les profils PONS dérivés : ils sont
        // reconstruits à partir de la table et de l'enchère publique.
        try {
            const generic = contractChanceDealState(deal, false);
            if (generic && generic.sides) {
                const sides = {};
                for (const side of ['NS', 'EW']) {
                    const sideState = generic.sides[side];
                    if (!sideState) continue;
                    sides[side] = {
                        adaptiveTarget: Number(sideState.adaptiveTarget || CONTRACT_CHANCE_TARGET),
                        adaptiveSettled: !!sideState.adaptiveSettled,
                        failures: Number(sideState.failures || 0),
                        entries: serializeEntries(sideState.entries, value => {
                            if (!value || !contractChanceTableIsValid(value.table)) return null;
                            return value.table;
                        })
                    };
                }
                resume.generic = { sides };
            }
        } catch (_) {}

        return resume;
    }

    function resumeCompatible(deal, resume) {
        if (!deal || !resume || resume.version !== RESUME_VERSION) return false;
        let signature = '';
        try { signature = statisticalParAuctionSignature(deal); } catch (_) { return false; }
        if (String(resume.auctionSignature || '') !== signature) return false;
        const expected = window.PlayStatisticalPar && window.PlayStatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION;
        if (expected && resume.samplingSeedVersion && String(resume.samplingSeedVersion) !== String(expected)) return false;
        return true;
    }

    function restoreEntries(rows, map, valueFactory) {
        if (!Array.isArray(rows) || !(map instanceof Map)) return 0;
        let added = 0;
        for (const row of rows) {
            if (!Array.isArray(row) || row.length < 2) continue;
            const idx = finiteInt(row[0], 0, CONTRACT_CHANCE_ADAPTIVE_MAX_TARGET - 1);
            if (idx === null || map.has(idx)) continue;
            const value = valueFactory(row[1], idx);
            if (value === null || value === undefined) continue;
            map.set(idx, value);
            added++;
        }
        return added;
    }

    function hydrateDealResume(deal) {
        if (!deal || hydratedDeals.has(deal)) return 0;
        hydratedDeals.add(deal);
        const resume = deal.statisticalChanceResumeV1;
        if (!resumeCompatible(deal, resume)) return 0;

        let added = 0;
        try {
            if (resume.fast && resume.fast.key) {
                const fast = contractChanceFastPrimaryState(deal, true);
                if (fast) {
                    fast.key = String(resume.fast.key || '');
                    fast.groupKey = `fast-par:${dealToPbnStringForDD(deal)}|${fast.key}`;
                    fast.target = resume.fast.target ? { ...resume.fast.target } : null;
                    fast.declarer = String(resume.fast.declarer || '');
                    fast.failures = Number(resume.fast.failures || 0);
                    fast.pending.clear();
                    added += restoreEntries(resume.fast.entries, fast.entries, value => validTricks(value));
                }
            }
        } catch (_) {}

        try {
            const map = contractChanceDirectStateMap(deal, true);
            if (map instanceof Map && Array.isArray(resume.direct)) {
                for (const saved of resume.direct) {
                    if (!saved || !saved.cell || !saved.key || !saved.planKey) continue;
                    const cellKey = String(saved.cell.key || '');
                    if (!cellKey) continue;
                    let state = map.get(cellKey) || null;
                    if (!state) {
                        state = {
                            key: String(saved.key),
                            cell: { ...saved.cell },
                            planKey: String(saved.planKey),
                            groupKey: `direct-par:${dealToPbnStringForDD(deal)}|${saved.key}`,
                            entries: new Map(),
                            pending: new Set(),
                            failures: Number(saved.failures || 0),
                            adaptiveTarget: Number(saved.adaptiveTarget || CONTRACT_CHANCE_TARGET),
                            adaptiveSettled: !!saved.adaptiveSettled
                        };
                        map.set(cellKey, state);
                    }
                    added += restoreEntries(saved.entries, state.entries, value => validTricks(value));
                }
            }
        } catch (_) {}

        try {
            const savedSides = resume.generic && resume.generic.sides;
            if (savedSides) {
                const generic = contractChanceDealState(deal, true);
                for (const side of ['NS', 'EW']) {
                    const saved = savedSides[side];
                    const sideState = generic && generic.sides && generic.sides[side];
                    if (!saved || !sideState) continue;
                    sideState.adaptiveTarget = Number(saved.adaptiveTarget || sideState.adaptiveTarget || CONTRACT_CHANCE_TARGET);
                    sideState.adaptiveSettled = !!saved.adaptiveSettled;
                    sideState.failures = Number(saved.failures || sideState.failures || 0);
                    added += restoreEntries(saved.entries, sideState.entries, (table, idx) => {
                        if (!contractChanceTableIsValid(table)) return null;
                        return { table, profiles: null, sampleIndex: idx, fixedSide: side };
                    });
                }
            }
        } catch (_) {}

        if (added > 0) {
            try { contractChanceUpdateAdaptiveTargets(deal); } catch (_) {}
            try { scheduleContractChanceDisplayRefresh(deal, true); } catch (_) {}
            try { recordPlayPerfMilestone('stat-par-resume-hydrated', { board: deal.board, samples: added }); } catch (_) {}
        }
        return added;
    }

    function resumeFingerprint(resume) {
        if (!resume) return '';
        const fastN = resume.fast && Array.isArray(resume.fast.entries) ? resume.fast.entries.length : 0;
        const directN = Array.isArray(resume.direct)
            ? resume.direct.reduce((sum, state) => sum + (Array.isArray(state && state.entries) ? state.entries.length : 0), 0)
            : 0;
        const genericN = resume.generic && resume.generic.sides
            ? ['NS', 'EW'].reduce((sum, side) => sum + (Array.isArray(resume.generic.sides[side] && resume.generic.sides[side].entries) ? resume.generic.sides[side].entries.length : 0), 0)
            : 0;
        return `${resume.auctionSignature}|${fastN}|${directN}|${genericN}`;
    }

    function persistCurrentHostDealsLocalOnly(force) {
        if (typeof myRole === 'undefined' || myRole !== 'host' || !Array.isArray(deals) || !currentRoomCode) return false;
        let map;
        try { map = readAllHostGameStates(); } catch (_) { return false; }
        const entry = map && map[currentRoomCode];
        if (!entry) {
            try { saveHostGameStateToStorage(); return true; } catch (_) { return false; }
        }
        entry.deals = deals;
        entry.boardIndex = boardIndex;
        entry.savedAt = Date.now();
        try {
            writeAllHostGameStates(map);
            return true;
        } catch (_) {
            if (force) {
                try { saveHostGameStateToStorage(); return true; } catch (_) {}
            }
            return false;
        }
    }

    function persistDealProgress(deal, force) {
        if (!deal || typeof myRole === 'undefined' || myRole !== 'host') return;
        const resume = serializeDealResume(deal);
        if (!resume) return;
        const fingerprint = resumeFingerprint(resume);
        const now = Date.now();
        const lastAt = Number(lastSavedAt.get(deal) || 0);
        if (!force && fingerprint === lastSavedFingerprint.get(deal)) return;
        if (!force && now - lastAt < SAVE_THROTTLE_MS) return;
        deal.statisticalChanceResumeV1 = resume;
        if (persistCurrentHostDealsLocalOnly(force)) {
            lastSavedAt.set(deal, now);
            lastSavedFingerprint.set(deal, fingerprint);
            try { recordPlayPerfMilestone('stat-par-progress-persisted', { board: deal.board, fingerprint }); } catch (_) {}
        }
    }

    // 1) Réhydrater avant que les ordonnanceurs ne décident quels sampleIndex sont manquants.
    const originalQueueForDeal = contractChanceQueueForDeal;
    contractChanceQueueForDeal = function (deal, priority) {
        try { hydrateDealResume(deal); } catch (_) {}
        return originalQueueForDeal(deal, priority);
    };

    const originalDirectStateForTarget = contractChanceDirectStateForTarget;
    contractChanceDirectStateForTarget = function (deal, target, create) {
        try { hydrateDealResume(deal); } catch (_) {}
        return originalDirectStateForTarget(deal, target, create);
    };

    // 2) Pendant l'enchère, si PONS dispose déjà de contraintes publiques informatives ET
    // que le déclarant de la dénomination prioritaire est irréversiblement connu, utiliser
    // immédiatement le plan conditionné. À la prochaine enchère, planKey change : le code
    // R139 existant annule naturellement l'ancien groupe et repart sur le nouveau plan.
    const originalQueueFastPrimary = contractChanceQueueFastPrimary;
    contractChanceQueueFastPrimary = function (deal, allowConditioning) {
        let useConditioning = !!allowConditioning;
        if (!useConditioning && deal && deal.ddTable && deal.hands) {
            try {
                const target = contractChancePrimaryParTarget(deal);
                if (target && target.kind !== 'sacrifice' && ['NS', 'EW'].includes(target.side)) {
                    const establishedDeclarer = contractChanceFastPrimaryDeclarer(deal, target, true);
                    const config = contractChanceConfigForSide(target.side);
                    const conditioning = statisticalParPublicConditioning(deal, config);
                    if (establishedDeclarer && conditioning && conditioning.informative) useConditioning = true;
                }
            } catch (_) {}
        }
        try { hydrateDealResume(deal); } catch (_) {}
        return originalQueueFastPrimary(deal, useConditioning);
    };

    // 3) Chaque publication de snapshot sérialise aussi les DDS réellement acquis.
    const originalPublishSnapshot = publishContractChanceSnapshot;
    publishContractChanceSnapshot = function (deal) {
        const result = originalPublishSnapshot(deal);
        try {
            const snapshot = deal && deal.statisticalChanceSnapshot;
            const allDone = !!(snapshot && snapshot.values && Object.values(snapshot.values).length
                && Object.values(snapshot.values).every(value => value && value.done));
            persistDealProgress(deal, allDone);
        } catch (_) {}
        return result;
    };

    // 4) L'enchère peut évoluer sans qu'un nouvel appel à queueForDeal soit immédiat.
    // Cette sonde légère ne calcule rien elle-même : elle réveille simplement R139 quand
    // la signature publique change, puis se rendort jusqu'à la prochaine annonce.
    setInterval(() => {
        try {
            if (typeof myRole === 'undefined' || myRole !== 'host' || !Array.isArray(deals) || !deals.length) return;
            const deal = currentDeal();
            if (!deal || !deal.statisticalParMode || !deal.ddTable || !deal.hands) return;
            const signature = statisticalParAuctionSignature(deal);
            if (lastAuctionSignature.get(deal) === signature) return;
            lastAuctionSignature.set(deal, signature);
            hydrateDealResume(deal);
            if (signature) contractChanceQueueFastPrimary(deal, false);
            persistDealProgress(deal, true);
        } catch (_) {}
    }, PREWARM_POLL_MS);

    // Dernier filet de sécurité : persister l'état courant avant qu'un refresh/fermeture
    // ne tue les Worker Threads. pagehide est plus fiable que beforeunload sur mobile.
    window.addEventListener('pagehide', () => {
        try {
            if (!Array.isArray(deals)) return;
            for (const deal of deals) {
                if (deal && deal.statisticalParMode) {
                    deal.statisticalChanceResumeV1 = serializeDealResume(deal) || deal.statisticalChanceResumeV1;
                }
            }
            persistCurrentHostDealsLocalOnly(true);
        } catch (_) {}
    }, { capture: true });

    try { recordPlayPerfMilestone('stat-par-runtime-patch-ready', 'R141'); } catch (_) {}
})();
