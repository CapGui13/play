// session-storage.js — Persistance cloud de l'état de partie (sessions asynchrones).
//
// Complète saveHostGameStateToStorage()/localStorage (app.js) : celui-ci ne survit que sur
// le MÊME appareil/navigateur. Ici, on pousse le même genre d'instantané vers un petit
// backend (voir api/session.js) accessible depuis n'importe quel appareil via le code de
// salon — c'est ce qui permet à un partenaire de revenir jouer ses propres enchères des
// heures plus tard, depuis son propre téléphone, sans que l'autre soit resté connecté.
//
// Ce fichier ne connaît RIEN de la structure du payload (deals, seatAssignment, etc.) —
// il se contente de le sérialiser/désérialiser et de gérer la version optimiste. C'est à
// app.js de décider QUOI envoyer (même forme que saveHostGameStateToStorage) et QUAND
// (mêmes points d'accroche : applyCall, gotoBoard, changement de sièges...).

// À renseigner une fois l'endpoint déployé (voir api/session.js) — ex.
// 'https://api-gen-beta.vercel.app' si tu l'ajoutes au même projet Vercel que le
// générateur de donnes, ou l'URL d'un nouveau projet dédié.
const SESSION_API_BASE = 'https://api-gen-beta.vercel.app';

// Nombre de tentatives en cas d'échec réseau transitoire (même esprit que
// MAX_INITIAL_CONNECT_RETRIES dans peer-connection.js) — un push cloud manqué n'est pas
// grave en soi (la sauvegarde localStorage reste, elle, immédiate), mais autant réessayer
// avant d'abandonner silencieusement.
const SESSION_PUSH_RETRIES = 2;
const SESSION_PUSH_RETRY_DELAY_MS = 1000;

function sessionApiUrl(roomCode) {
    return `${SESSION_API_BASE}/api/session?code=${encodeURIComponent(roomCode)}`;
}

// Récupère le dernier état connu pour ce code de salon.
// Renvoie { version, updatedAt, state } si trouvé, ou null si rien n'est encore sauvegardé
// pour ce code (404 — cas normal pour une toute nouvelle salle qui n'a encore rien poussé).
async function pullSessionState(roomCode) {
    const resp = await fetch(sessionApiUrl(roomCode), { method: 'GET' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`pullSessionState: HTTP ${resp.status}`);
    return resp.json();
}

// Pousse un nouvel état. `expectedVersion` (le dernier numéro de version connu localement,
// ou 0/undefined pour une toute première écriture) protège contre une écriture concurrente
// accidentelle : si quelqu'un d'autre a écrit depuis, le serveur répond 409 avec l'état
// courant plutôt que d'accepter un écrasement à l'aveugle — voir le paramètre `onConflict`.
//
// Conçu pour être appelé "en tâche de fond" (fire-and-forget) depuis app.js : ne bloque
// jamais l'interface, réessaie tout seul en cas d'aléa réseau, et journalise sans lever
// d'exception non gérée au-delà des tentatives prévues (un push cloud manqué ne doit
// jamais empêcher de continuer à jouer localement).
async function pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft = SESSION_PUSH_RETRIES } = {}) {
    try {
        const resp = await fetch(sessionApiUrl(roomCode), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, expectedVersion })
        });

        if (resp.status === 409) {
            const body = await resp.json().catch(() => null);
            if (onConflict) onConflict(body && body.current);
            return null;
        }
        if (!resp.ok) throw new Error(`pushSessionState: HTTP ${resp.status}`);
        return resp.json(); // { version, updatedAt }
    } catch (err) {
        if (retriesLeft > 0) {
            await new Promise(r => setTimeout(r, SESSION_PUSH_RETRY_DELAY_MS));
            return pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft: retriesLeft - 1 });
        }
        console.warn('[session-storage] push cloud échoué (partie continue localement) :', err);
        return null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pullSessionState, pushSessionState };
}
