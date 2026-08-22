// session-storage.js — Persistance cloud authentifiée de l'état de partie.
//
// Le code 4 chiffres reste un identifiant humain. L'accès cloud utilise en plus une clé
// de capacité aléatoire propre à la salle, stockée localement sur chaque appareil ayant
// réellement participé. La capacité de lecture/relais est reçue lors de la réservation
// (hôte) ou via le P2P ciblé ('session-access') après autorisation par l'hôte. Le lien
// de partage court ne transporte aucun secret. La capacité d'écriture complète du host
// est distincte, reste locale à l'appareil hôte et n'est jamais envoyée aux invités.

const SESSION_API_BASE = 'https://api-gen-beta.vercel.app';
const SESSION_PUSH_RETRIES = 2;
const SESSION_PUSH_RETRY_DELAY_MS = 1000;
const SESSION_ACCESS_KEYS_STORAGE = 'bridgeSessionAccessKeysV1';
const SESSION_HOST_WRITE_KEYS_STORAGE = 'bridgeSessionHostWriteKeysV1';
const SESSION_ACCESS_KEY_MAX_AGE_MS = 70 * 24 * 60 * 60 * 1000;
let fallbackSessionAccessKeys = {};
let fallbackSessionHostWriteKeys = {};

// Mode de développement par ouverture directe du fichier index.html (file://).
// Dans ce contexte le navigateur ne possède pas une origine HTTP normale pour les appels
// CORS vers l'API de session. La table P2P/PeerJS reste parfaitement utilisable : on
// désactive donc uniquement la couche cloud de session et on laisse le reste de l'app
// fonctionner normalement. Le site hébergé n'emprunte jamais cette branche.
function isLocalFileSessionMode() {
    try { return typeof window !== 'undefined' && window.location && window.location.protocol === 'file:'; }
    catch (e) { return false; }
}

function makeLocalSessionRoomCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += Math.floor(Math.random() * 10);
    return code;
}

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

function readSessionHostWriteKeyMap() {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(SESSION_HOST_WRITE_KEYS_STORAGE) || '{}'); }
    catch (e) { map = fallbackSessionHostWriteKeys || {}; }
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
        try { localStorage.setItem(SESSION_HOST_WRITE_KEYS_STORAGE, JSON.stringify(map)); }
        catch (e) { fallbackSessionHostWriteKeys = map; }
    }
    return map;
}

function rememberSessionHostWriteKey(roomCode, writeKey) {
    const code = normalizeSessionRoomCode(roomCode);
    const key = typeof writeKey === 'string' ? writeKey.trim() : '';
    if (!code || !key || key.length < 24 || key.length > 256) return false;
    const map = readSessionHostWriteKeyMap();
    map[code] = { key, savedAt: Date.now() };
    fallbackSessionHostWriteKeys = map;
    try { localStorage.setItem(SESSION_HOST_WRITE_KEYS_STORAGE, JSON.stringify(map)); } catch (e) { /* mémoire seulement */ }
    return true;
}

function getSessionHostWriteKey(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    const item = readSessionHostWriteKeyMap()[code];
    return item && typeof item.key === 'string' ? item.key : null;
}

function forgetSessionHostWriteKey(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    const map = readSessionHostWriteKeyMap();
    delete map[code];
    fallbackSessionHostWriteKeys = map;
    try { localStorage.setItem(SESSION_HOST_WRITE_KEYS_STORAGE, JSON.stringify(map)); } catch (e) { /* mémoire seulement */ }
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

// Réserve un code 4 chiffres. Le backend courant renvoie deux capacités distinctes :
// lecture/relais et écriture complète host. Ce client exige les deux pour activer une
// nouvelle salle ; déployer donc l'API avant le client pour ce lot coordonné.
async function reserveFreshRoomCode() {
    // Ouverture directe depuis le disque : pas d'appel Vercel/CORS. Une éventuelle
    // collision PeerJS est déjà gérée par _attemptCreateRoom(), qui redemande alors un
    // nouveau code à cette même fonction.
    if (isLocalFileSessionMode()) return makeLocalSessionRoomCode();

    const perf = (name, detail) => {
        try {
            if (typeof window !== 'undefined' && typeof window.recordPlayPerfMilestone === 'function') {
                window.recordPlayPerfMilestone(name, detail);
            }
        } catch (e) { /* diagnostic seulement */ }
    };
    // IMPORTANT PERF : le nouvel endpoint n'a besoin d'aucun body. Un POST sans header
    // Content-Type non-safelisted est une requête CORS "simple" : pas d'OPTIONS préalable.
    // L'ancien JSON déclenchait un aller-retour preflight avant chaque création de salle.
    const requestLight = (url) => fetch(url, { method: 'POST', cache: 'no-store' });
    const requestLegacy = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
    });

    let resp;
    perf('reserve-start');
    resp = await requestLight(`${SESSION_API_BASE}/api/reserve-code`);
    if (resp.status === 404 || resp.status === 405) {
        // Compat uniquement avec un backend réellement ancien. Une erreur RÉSEAU du petit
        // endpoint n'est plus doublée par un second appel lourd au même Vercel : cela
        // fabriquait précisément de très longues valeurs aberrantes lors des incidents.
        perf('reserve-legacy-fallback');
        resp = await requestLegacy(`${SESSION_API_BASE}/api/session`, { action: 'reserve-code' });
    }

    perf('reserve-response', { status: resp.status });
    if (!resp.ok) throw new Error(`reserveFreshRoomCode: HTTP ${resp.status}`);
    const body = await resp.json();
    const code = body && String(body.code || '').trim();
    if (!/^\d{4}$/.test(code)) throw new Error('reserveFreshRoomCode: réponse serveur invalide');
    if (body && typeof body.accessKey === 'string') rememberSessionAccessKey(code, body.accessKey);
    if (body && typeof body.hostWriteKey === 'string') rememberSessionHostWriteKey(code, body.hostWriteKey);
    return code;
}

// Promeut la réservation courte après ouverture PeerJS. Sans cette étape, un hôte qui
// reste plus de deux minutes au salon avant de lancer la partie perdrait sa réservation
// avant le premier snapshot. Un ancien backend peut répondre 400 : c'est volontairement
// non bloquant pendant un déploiement client-first.
async function activateRoomAccess(roomCode) {
    if (isLocalFileSessionMode()) return true;
    const code = normalizeSessionRoomCode(roomCode);
    const accessKey = getSessionAccessKey(code);
    const hostWriteKey = getSessionHostWriteKey(code);
    if (!code || !accessKey || !hostWriteKey) return false;
    try {
        const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Session-Key': accessKey,
                'X-Bridge-Host-Write-Key': hostWriteKey
            },
            body: JSON.stringify({ action: 'activate-room', code }),
            cache: 'no-store'
        });
        return resp.ok;
    } catch (e) {
        return false;
    }
}


// Génère une capacité 256 bits sans fallback pseudo-aléatoire. La rotation est une action
// de sécurité : si Web Crypto n'est pas disponible, on refuse plutôt que d'affaiblir le
// secret avec Math.random().
function generateSessionCapabilityKey() {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') return null;
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function probeSessionCapabilities(roomCode, accessKey, hostWriteKey) {
    try {
        const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Session-Key': accessKey,
                'X-Bridge-Host-Write-Key': hostWriteKey
            },
            body: JSON.stringify({ action: 'activate-room', code: normalizeSessionRoomCode(roomCode) }),
            cache: 'no-store'
        });
        return resp.ok;
    } catch (e) {
        return false;
    }
}

// Révoque le couple de capacités courant et le remplace atomiquement. Les nouvelles clés
// sont choisies AVANT la requête : si la réponse se perd après le commit Redis, le client
// peut vérifier le couple proposé et éviter de perdre l'autorité de la salle.
async function rotateSessionCapabilities(roomCode) {
    if (isLocalFileSessionMode()) return false;
    const code = normalizeSessionRoomCode(roomCode);
    const oldAccessKey = getSessionAccessKey(code);
    const oldHostWriteKey = getSessionHostWriteKey(code);
    if (!code || !oldAccessKey || !oldHostWriteKey) return false;

    const newAccessKey = generateSessionCapabilityKey();
    let newHostWriteKey = generateSessionCapabilityKey();
    if (!newAccessKey || !newHostWriteKey) return false;
    while (newHostWriteKey === newAccessKey) newHostWriteKey = generateSessionCapabilityKey();

    let confirmed = false;
    let ambiguous = false;
    try {
        const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Session-Key': oldAccessKey,
                'X-Bridge-Host-Write-Key': oldHostWriteKey
            },
            body: JSON.stringify({
                action: 'rotate-room-capabilities', code,
                newAccessKey, newHostWriteKey
            }),
            cache: 'no-store'
        });
        if (resp.ok) confirmed = true;
        else if (resp.status >= 500) ambiguous = true;
        else return false;
    } catch (e) {
        ambiguous = true;
    }

    if (!confirmed && ambiguous) {
        confirmed = await probeSessionCapabilities(code, newAccessKey, newHostWriteKey);
    }
    if (!confirmed) return false;

    rememberSessionAccessKey(code, newAccessKey);
    rememberSessionHostWriteKey(code, newHostWriteKey);
    return true;
}

async function registerSessionParticipantCredential(roomCode, participantId, reconnectSecret) {
    if (isLocalFileSessionMode()) return false;
    const code = normalizeSessionRoomCode(roomCode);
    const accessKey = getSessionAccessKey(code);
    const hostWriteKey = getSessionHostWriteKey(code);
    if (!code || !accessKey || !hostWriteKey || !participantId || !reconnectSecret) return false;
    try {
        const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Session-Key': accessKey,
                'X-Bridge-Host-Write-Key': hostWriteKey
            },
            body: JSON.stringify({ action: 'register-participant', code, participantId, reconnectSecret }),
            cache: 'no-store'
        });
        return resp.ok;
    } catch (e) {
        return false;
    }
}

async function pullSessionState(roomCode) {
    if (isLocalFileSessionMode()) return null;
    const resp = await fetchWithSessionCapability(roomCode, sessionApiUrl(roomCode), { method: 'GET', cache: 'no-store' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`pullSessionState: HTTP ${resp.status}`);
    return resp.json();
}

async function pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft = SESSION_PUSH_RETRIES, participantCredential = null } = {}) {
    if (isLocalFileSessionMode()) return null;
    try {
        const code = normalizeSessionRoomCode(roomCode);
        const headers = { 'Content-Type': 'application/json' };
        const hostWriteKey = getSessionHostWriteKey(code);
        if (hostWriteKey) {
            headers['X-Bridge-Host-Write-Key'] = hostWriteKey;
        } else if (participantCredential && participantCredential.participantId && participantCredential.reconnectSecret) {
            headers['X-Bridge-Participant-Id'] = participantCredential.participantId;
            headers['X-Bridge-Reconnect-Secret'] = participantCredential.reconnectSecret;
        }
        const resp = await fetchWithSessionCapability(roomCode, sessionApiUrl(roomCode), {
            method: 'PUT',
            headers,
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
            return pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft: retriesLeft - 1, participantCredential });
        }
        console.warn('[session-storage] push cloud échoué (partie continue localement) :', err);
        return null;
    }
}

async function pushSessionLogEntries(roomCode, entries) {
    if (isLocalFileSessionMode()) return;
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
    if (isLocalFileSessionMode()) return [];
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
        getSessionHostWriteKey, rememberSessionHostWriteKey, forgetSessionHostWriteKey,
        registerSessionParticipantCredential,
        claimLegacySessionAccess, activateRoomAccess, rotateSessionCapabilities
    };
}
