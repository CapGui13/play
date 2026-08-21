// session-storage.js — Persistance cloud authentifiée de l'état de partie.
//
// Le code 4 chiffres reste un identifiant humain. L'accès cloud utilise en plus une clé
// de capacité aléatoire propre à la salle, stockée localement sur chaque appareil ayant
// réellement participé. Cette clé est reçue lors de la réservation, via le lien de partage
// ou via le P2P ('session-access'). Elle n'est jamais incluse dans le snapshot de partie.

const SESSION_API_BASE = 'https://api-gen-beta.vercel.app';
const SESSION_PUSH_RETRIES = 2;
const SESSION_PUSH_RETRY_DELAY_MS = 1000;
const SESSION_ACCESS_KEYS_STORAGE = 'bridgeSessionAccessKeysV1';
const SESSION_ACCESS_KEY_MAX_AGE_MS = 70 * 24 * 60 * 60 * 1000;
let fallbackSessionAccessKeys = {};

function normalizeSessionRoomCode(roomCode) {
    return String(roomCode || '').toUpperCase().trim();
}

function readSessionAccessKeyMap() {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(SESSION_ACCESS_KEYS_STORAGE) || '{}'); }
    catch (e) { map = fallbackSessionAccessKeys || {}; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
    const now = Date.now();
    let changed = false;
    for (const code of Object.keys(map)) {
        const item = map[code];
        if (!item || typeof item.key !== 'string' || !item.key || !Number.isFinite(item.savedAt)
            || now - item.savedAt > SESSION_ACCESS_KEY_MAX_AGE_MS) {
            delete map[code]; changed = true;
        }
    }
    if (changed) {
        try { localStorage.setItem(SESSION_ACCESS_KEYS_STORAGE, JSON.stringify(map)); }
        catch (e) { fallbackSessionAccessKeys = map; }
    }
    return map;
}

function rememberSessionAccessKey(roomCode, accessKey) {
    const code = normalizeSessionRoomCode(roomCode);
    const key = typeof accessKey === 'string' ? accessKey.trim() : '';
    if (!code || !key || key.length < 24 || key.length > 256) return false;
    const map = readSessionAccessKeyMap();
    map[code] = { key, savedAt: Date.now() };
    fallbackSessionAccessKeys = map;
    try { localStorage.setItem(SESSION_ACCESS_KEYS_STORAGE, JSON.stringify(map)); } catch (e) { /* mémoire seulement */ }
    return true;
}

function getSessionAccessKey(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    const item = readSessionAccessKeyMap()[code];
    return item && typeof item.key === 'string' ? item.key : null;
}

function forgetSessionAccessKey(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    const map = readSessionAccessKeyMap();
    delete map[code];
    fallbackSessionAccessKeys = map;
    try { localStorage.setItem(SESSION_ACCESS_KEYS_STORAGE, JSON.stringify(map)); } catch (e) { /* mémoire seulement */ }
}

function sessionApiUrl(roomCode) {
    return `${SESSION_API_BASE}/api/session?code=${encodeURIComponent(roomCode)}&_=${Date.now()}`;
}
function sessionLogApiUrl(roomCode) {
    return `${SESSION_API_BASE}/api/session-log?code=${encodeURIComponent(roomCode)}&_=${Date.now()}`;
}
function sessionAuthHeaders(roomCode, withJson = false) {
    const headers = {};
    if (withJson) headers['Content-Type'] = 'application/json';
    const accessKey = getSessionAccessKey(roomCode);
    if (accessKey) headers['X-Bridge-Session-Key'] = accessKey;
    return headers;
}
// La migration `claim-legacy` a été volontairement désactivée : un identifiant/ticket
// présent dans un ancien snapshot n'est pas une preuve secrète et ne doit jamais permettre
// de récupérer la capacité durable d'une salle sécurisée. Les anciennes salles sans clé
// doivent être recréées plutôt que converties automatiquement.
async function claimLegacySessionAccess() {
    return null;
}

async function fetchWithSessionCapability(roomCode, url, options = {}) {
    const code = normalizeSessionRoomCode(roomCode);
    const opts = { ...options, headers: { ...(options.headers || {}), ...sessionAuthHeaders(code, false) } };
    return fetch(url, opts);
}

// Réserve un code 4 chiffres. Avec le backend sécurisé, la réponse contient aussi la clé
// de capacité ; les anciens backends ne renvoient que le code, ce qui garde un déploiement
// client-first possible (le polling continue alors en mode legacy jusqu'au déploiement API).
async function reserveFreshRoomCode() {
    const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reserve-code' }),
        cache: 'no-store'
    });
    if (!resp.ok) throw new Error(`reserveFreshRoomCode: HTTP ${resp.status}`);
    const body = await resp.json();
    const code = body && String(body.code || '').trim();
    if (!/^\d{4}$/.test(code)) throw new Error('reserveFreshRoomCode: réponse serveur invalide');
    if (body && typeof body.accessKey === 'string') rememberSessionAccessKey(code, body.accessKey);
    return code;
}

// Promeut la réservation courte après ouverture PeerJS. Sans cette étape, un hôte qui
// reste plus de deux minutes au salon avant de lancer la partie perdrait sa réservation
// avant le premier snapshot. Un ancien backend peut répondre 400 : c'est volontairement
// non bloquant pendant un déploiement client-first.
async function activateRoomAccess(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    const accessKey = getSessionAccessKey(code);
    if (!code || !accessKey) return false;
    try {
        const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bridge-Session-Key': accessKey },
            body: JSON.stringify({ action: 'activate-room', code }),
            cache: 'no-store'
        });
        return resp.ok;
    } catch (e) {
        return false;
    }
}

async function pullSessionState(roomCode) {
    const resp = await fetchWithSessionCapability(roomCode, sessionApiUrl(roomCode), { method: 'GET', cache: 'no-store' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`pullSessionState: HTTP ${resp.status}`);
    return resp.json();
}

async function pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft = SESSION_PUSH_RETRIES } = {}) {
    try {
        const resp = await fetchWithSessionCapability(roomCode, sessionApiUrl(roomCode), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, expectedVersion }),
            keepalive: true
        });
        if (resp.status === 409) {
            const body = await resp.json().catch(() => null);
            if (onConflict) onConflict(body && body.current);
            return null;
        }
        if (!resp.ok) throw new Error(`pushSessionState: HTTP ${resp.status}`);
        return resp.json();
    } catch (err) {
        if (retriesLeft > 0) {
            await new Promise(r => setTimeout(r, SESSION_PUSH_RETRY_DELAY_MS));
            return pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft: retriesLeft - 1 });
        }
        console.warn('[session-storage] push cloud échoué (partie continue localement) :', err);
        return null;
    }
}

async function pushSessionLogEntries(roomCode, entries) {
    if (!entries || entries.length === 0) return;
    try {
        const resp = await fetchWithSessionCapability(roomCode, sessionLogApiUrl(roomCode), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
            keepalive: true
        });
        if (!resp.ok) throw new Error(`pushSessionLogEntries: HTTP ${resp.status}`);
    } catch (e) {
        console.warn('[session-storage] push journal partagé échoué (sans conséquence pour la partie) :', e);
    }
}

async function pullSessionLog(roomCode) {
    const resp = await fetchWithSessionCapability(roomCode, sessionLogApiUrl(roomCode), { method: 'GET', cache: 'no-store' });
    if (!resp.ok) throw new Error(`pullSessionLog: HTTP ${resp.status}`);
    const body = await resp.json();
    return (body && body.entries) || [];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        pullSessionState, pushSessionState, reserveFreshRoomCode,
        pushSessionLogEntries, pullSessionLog,
        getSessionAccessKey, rememberSessionAccessKey, forgetSessionAccessKey,
        claimLegacySessionAccess, activateRoomAccess
    };
}
