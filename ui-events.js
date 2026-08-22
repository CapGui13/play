// ui-events.js — délégation d'événements compatible CSP stricte.
//
// PLAY n'utilise plus de handlers JavaScript inline (onclick/onchange/...). Les éléments
// statiques et ceux générés dynamiquement portent uniquement des attributs data-ui-* ; ce
// fichier, chargé après app.js, fait le routage explicite vers les fonctions autorisées.
// Aucune évaluation de chaîne (eval/Function) n'est utilisée.

(() => {
    'use strict';

    function uiEvent(event, currentTarget) {
        return {
            target: event.target,
            currentTarget,
            key: event.key,
            code: event.code,
            relatedTarget: event.relatedTarget,
            dataTransfer: event.dataTransfer,
            touches: event.touches,
            changedTouches: event.changedTouches,
            preventDefault: () => event.preventDefault(),
            stopPropagation: () => event.stopPropagation(),
            stopImmediatePropagation: () => event.stopImmediatePropagation(),
            get defaultPrevented() { return event.defaultPrevented; }
        };
    }

    function elementsOnPath(start, attr) {
        const out = [];
        let el = start instanceof Element ? start : null;
        while (el) {
            if (el.hasAttribute(attr)) out.push(el);
            el = el.parentElement;
        }
        return out;
    }

    function call(name, ...args) {
        const fn = window[name];
        if (typeof fn === 'function') return fn(...args);
        console.warn(`[ui-events] action indisponible: ${name}`);
    }

    function routeClick(el, event) {
        const e = uiEvent(event, el);
        switch (el.dataset.uiClick) {
            case 'reconnect': return call('uiReconnect');
            case 'scroll-chat': return call('uiScrollToChat');
            case 'toggle-debug': return call('uiToggleDebugPanel');
            case 'send-chat': return call('uiSendChatMessage');
            case 'dismiss-ios-install': return call('uiDismissIosInstallHint');
            case 'test-turn': return call('testTurnConnectivity');
            case 'copy-debug': return call('uiCopyDebugLog');
            case 'confirm-nickname': return call('uiConfirmNicknamePrompt');
            case 'create-room': return call('uiCreateRoom');
            case 'join-room': return call('uiJoinRoom');
            case 'join-code-digit': return call('uiJoinCodeKeypadDigit', el.dataset.digit || '');
            case 'join-code-backspace': return call('uiJoinCodeKeypadBackspace');
            case 'dismiss-ios-lock': return call('uiDismissIosLockScreenWarning');
            case 'report-bug': return call('uiReportBug');
            case 'copy-share-link': return call('uiCopyShareLink', el);
            case 'toggle-transfer-menu': return call('uiToggleTransferMenu');
            case 'toggle-random-constraints': return call('uiToggleRandomDealConstraints');
            case 'generate-random-deals': return call('uiGenerateRandomDeals');
            case 'preview-deals': return call('uiPreviewDeals');
            case 'start-game': return call('uiStartGameAsHost');
            case 'retry-pons': return call('uiRetryPonsFromDiagnostic');
            case 'copy-pons-diagnostic': return call('uiCopyPonsDiagnostic');
            case 'prev-board': return call('uiHostSkipPrevBoard');
            case 'skip-next-board': return call('uiHostSkipNextBoard');
            case 'fast-forward': return call('uiFastForwardToMyTurn');
            case 'open-board-overview': return call('uiOpenBoardOverview');
            case 'request-undo': return call('uiRequestUndo');
            case 'reset-auction': return call('uiResetAuction');
            case 'all-pass': return call('uiAllPass');
            case 'rotate-seats': return call('uiRotateSeatsClockwise');
            case 'open-seat-reorg': return call('uiOpenSeatReorgModal');
            case 'export-session-pbn': return call('uiExportSessionPBN');
            case 'export-choice-local': return call('uiChooseExportLocal');
            case 'export-choice-github': return call('uiChooseExportGitHub');
            case 'close-export-choice': return call('uiCloseExportChoice');
            case 'close-export-choice-backdrop': return call('uiCloseExportChoiceOnBackdrop', e);
            case 'rotate-capabilities': return call('uiRotateRoomCapabilities');
            case 'toggle-french-ranks': return call('uiToggleFrenchRanks');
            case 'toggle-hcp': return call('uiToggleShowHcp');
            case 'toggle-kr': return call('uiToggleShowKr');
            case 'toggle-all-hands': return call('uiToggleHostSeeAllHands');
            case 'toggle-ledger-names': return call('uiToggleLedgerNames');
            case 'toggle-par': return call('uiToggleParBiddingView');
            case 'close-deal-preview-backdrop': return call('uiCloseDealPreviewOnBackdrop', e);
            case 'close-deal-preview': return call('uiCloseDealPreview');
            case 'validate-seat-reorg': return call('uiValidateSeatReorg');
            case 'cancel-seat-reorg': return call('uiCancelSeatReorg');
            case 'close-board-overview-backdrop': return call('uiCloseBoardOverviewOnBackdrop', e);
            case 'close-board-overview': return call('uiCloseBoardOverview');

            // Éléments générés dynamiquement par app.js.
            case 'randomize-avatar': return call('uiRandomizeAvatarColor', e, el.dataset.participantId || '');
            case 'rename-participant': return call('uiStartRenamingParticipant', e, el.dataset.participantId || '');
            case 'toggle-seat-dropdown': return call('uiToggleSeatDropdown', e, el.dataset.seat || '');
            case 'seat-select': {
                const seat = el.dataset.seat || '';
                const participantId = el.dataset.participantId || '';
                if (el.dataset.uiSeatHandler === 'stage') call('uiStageSeatAssignment', seat, participantId);
                else call('uiAssignSeat', seat, participantId);
                return call('uiCloseSeatDropdowns');
            }
            case 'transfer-host': return call('uiTransferHost', el.dataset.participantId || '');
            case 'self-wizz': return call('uiSelfWizz');
            case 'send-wizz': return call('uiSendWizz', el.dataset.participantId || '');
            case 'select-bid-level': return call('uiSelectBidLevel', Number(el.dataset.level));
            case 'select-bid-strain': return call('uiSelectBidStrain', el.dataset.strain || '');
            case 'make-call': return call('uiMakeCall', el.dataset.call || '');
            case 'export-deal-pbn': return call('uiExportDealPBN');
            case 'next-board': return call('uiNextBoard');
            case 'answer-undo': return call('uiAnswerUndo', el.dataset.approved === 'true');
            case 'jump-board': return call('uiJumpToBoardFromOverview', Number(el.dataset.boardIndex));
            case 'resume-host-session': return call('uiResumeHostSession', el.dataset.roomCode || '');
            case 'dismiss-resume-session': return call('uiDismissResumeSession', el.dataset.roomCode || '');
            default:
                console.warn('[ui-events] data-ui-click inconnu:', el.dataset.uiClick);
        }
    }

    function routeKeydown(el, event) {
        const e = uiEvent(event, el);
        if (el.dataset.uiKeydown === 'chat') return call('uiChatInputKeydown', e);
        if (el.dataset.uiKeydown === 'nickname') return call('uiNicknamePromptKeydown', e);
        if (el.dataset.uiKeydown === 'join-code') return call('uiJoinCodeInputKeydown', e);
    }

    function routeInput(el) {
        switch (el.dataset.uiInput) {
            case 'update-my-name': return call('uiUpdateMyName');
            case 'constraints-stale': return call('uiCheckConstraintsStale');
            case 'mirror-hcp': return call('uiMirrorLineHcpConstraint', el.dataset.uiMirrorId || el.id || '');
        }
    }

    function routeChange(el) {
        switch (el.dataset.uiChange) {
            case 'robot-mode': return call('uiSetRobotBiddingMode', !!el.checked);
            case 'randomize-deals': return call('uiToggleRandomizeDeals');
            case 'deal-library': return call('uiHandleDealLibraryChosen');
            case 'constraints-stale': return call('uiCheckConstraintsStale');
        }
    }

    document.addEventListener('click', (event) => {
        for (const el of elementsOnPath(event.target, 'data-ui-click')) {
            routeClick(el, event);
            if (event.cancelBubble) break;
        }
    });

    document.addEventListener('dblclick', (event) => {
        for (const el of elementsOnPath(event.target, 'data-ui-dblclick')) {
            if (el.dataset.uiDblclick === 'rename-participant') {
                call('uiStartRenamingParticipant', uiEvent(event, el), el.dataset.participantId || '');
            }
            if (event.cancelBubble) break;
        }
    });

    document.addEventListener('keydown', (event) => {
        for (const el of elementsOnPath(event.target, 'data-ui-keydown')) {
            routeKeydown(el, event);
            if (event.cancelBubble) break;
        }
    });

    // input/change bouillonnent : on reproduit volontairement tous les handlers de la
    // chaîne d'ancêtres. Exemple : un champ HCP déclenche son miroir ET marque le panneau
    // de contraintes comme modifié, comme avec les anciens attributs inline imbriqués.
    document.addEventListener('input', (event) => {
        for (const el of elementsOnPath(event.target, 'data-ui-input')) routeInput(el);
    });
    document.addEventListener('change', (event) => {
        for (const el of elementsOnPath(event.target, 'data-ui-change')) routeChange(el);
    });

    document.addEventListener('focusin', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-select-on-focus]') : null;
        if (el && typeof el.select === 'function') el.select();
    });
    document.addEventListener('focusout', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-blur]') : null;
        if (el && el.dataset.uiBlur === 'my-name') call('uiMyNameBlur');
    });
    document.addEventListener('touchstart', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-touchstart]') : null;
        if (el && el.dataset.uiTouchstart === 'blur-active' && document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
    }, { passive: true });

    document.addEventListener('dragstart', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-dragstart]') : null;
        if (!el || el.dataset.uiDragstart !== 'participant') return;
        call('uiDragStartParticipant', uiEvent(event, el), el.dataset.participantId || '', el.dataset.fromSeat || undefined);
    });
    document.addEventListener('dragover', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-dragover]') : null;
        if (el && el.dataset.uiDragover === 'allow-drop') call('uiAllowDrop', uiEvent(event, el));
    });
    document.addEventListener('dragenter', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-dragenter]') : null;
        if (el && el.dataset.uiDragenter === 'drop-target') call('uiDragEnterTarget', uiEvent(event, el));
    });
    document.addEventListener('dragleave', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-dragleave]') : null;
        if (el && el.dataset.uiDragleave === 'drop-target') call('uiDragLeaveTarget', uiEvent(event, el));
    });
    document.addEventListener('drop', (event) => {
        const el = event.target instanceof Element ? event.target.closest('[data-ui-drop]') : null;
        if (!el) return;
        if (el.dataset.uiDrop === 'seat') return call('uiDropOnSeat', uiEvent(event, el), el.dataset.seat || '');
        if (el.dataset.uiDrop === 'kibitz') return call('uiDropOnKibitz', uiEvent(event, el));
    });
})();
