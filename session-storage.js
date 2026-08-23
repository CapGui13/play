// session-storage.js — Persistance cloud authentifiée de l'état de partie.
//
// Le code 4 chiffres reste l'identifiant humain de la salle. En mode LIVE, l'accès cloud
// utilise en plus une capacité aléatoire propre à la salle, reçue lors de la réservation
// (hôte) ou via le P2P ciblé ('session-access') après autorisation. En mode DIFFÉRÉ
// explicite (siège « En attente d'un partenaire »), choix produit assumé : le code à
// 4 chiffres suffit aussi pour la reprise cloud à froid. La capacité d'écriture complète
// du host reste toujours distincte, aléatoire et locale à son appareil.

const SESSION_API_BASE = 'https://api-gen-beta.vercel.app';
const SESSION_PUSH_RETRIES = 2;
const SESSION_PUSH_RETRY_DELAY_MS = 1000;
const SESSION_ACCESS_KEYS_STORAGE = 'bridgeSessionAccessKeysV1';
const SESSION_HOST_WRITE_KEYS_STORAGE = 'bridgeSessionHostWriteKeysV1';
const SESSION_ACCESS_KEY_MAX_AGE_MS = 70 * 24 * 60 * 60 * 1000;
let fallbackSessionAccessKeys = {};
let fallbackSessionHostWriteKeys = {};

function sessionTrace(eventName, detail = {}) {
    try {
        if (typeof window !== 'undefined' && typeof window.recordSyncTrace === 'function') {
            window.recordSyncTrace(eventName, detail);
        }
    } catch (e) { /* diagnostic uniquement */ }
}

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


// Mode différé "code seul" : choix produit assumé. Pour une salle qui contient un siège
// "En attente d'un partenaire", le code à 4 chiffres devient volontairement la seule
// information nécessaire pour relire/reprendre la session quand le créateur est hors ligne.
// Ces valeurs sont donc DÉRIVABLES du code et ne constituent pas des secrets cryptographiques.
// Le mode live normal conserve, lui, les capacités aléatoires fortes renvoyées par l'API.
function deferredCodeOnlyAccessKey(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    if (!/^\d{4}$/.test(code)) return null;
    return `deferred_code_v1_${code.repeat(8)}`;
}

function deferredCodeOnlyParticipantCredential(roomCode) {
    const code = normalizeSessionRoomCode(roomCode);
    if (!/^\d{4}$/.test(code)) return null;
    return {
        participantId: 'p_' + (`dc${code}`).repeat(4),       // 24 caractères après p_
        reconnectSecret: 's_' + (`dc${code}join`).repeat(4) // 40 caractères après s_
    };
}

let deferredCodeOnlyEnablePromise = null;
let deferredCodeOnlyEnableRoom = null;

async function enableDeferredCodeOnlyRoomAccess(roomCode) {
    if (isLocalFileSessionMode()) return true;
    sessionTrace('deferred.enable.begin', { roomCode: normalizeSessionRoomCode(roomCode) });
    const code = normalizeSessionRoomCode(roomCode);
    const desiredAccessKey = deferredCodeOnlyAccessKey(code);
    const credential = deferredCodeOnlyParticipantCredential(code);
    if (!code || !desiredAccessKey || !credential) return false;

    if (deferredCodeOnlyEnablePromise && deferredCodeOnlyEnableRoom === code) {
        return deferredCodeOnlyEnablePromise;
    }

    deferredCodeOnlyEnableRoom = code;
    deferredCodeOnlyEnablePromise = (async () => {
        const currentAccessKey = getSessionAccessKey(code);
        const currentHostWriteKey = getSessionHostWriteKey(code);
        if (!currentAccessKey || !currentHostWriteKey) return false;

        // Pré-enregistrer d'abord l'identité dérivable du code. Si la rotation d'accès
        // réussit ensuite, un partenaire ne connaissant que les 4 chiffres pourra à la fois
        // lire le snapshot et écrire ses propres actions via cette credential.
        const registered = await registerSessionParticipantCredential(
            code, credential.participantId, credential.reconnectSecret
        );
        if (!registered) {
            sessionTrace('deferred.enable.register-failed', { roomCode: code });
            return false;
        }

        // Déjà convertie : ne surtout pas faire tourner la clé host à chaque rendu/clic.
        if (currentAccessKey === desiredAccessKey) return true;

        const newHostWriteKey = generateSessionCapabilityKey();
        if (!newHostWriteKey) return false;
        try {
            const resp = await fetch(`${SESSION_API_BASE}/api/session`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bridge-Session-Key': currentAccessKey,
                    'X-Bridge-Host-Write-Key': currentHostWriteKey
                },
                body: JSON.stringify({
                    action: 'rotate-room-capabilities', code,
                    newAccessKey: desiredAccessKey,
                    newHostWriteKey
                }),
                cache: 'no-store'
            });
            if (!resp.ok) return false;
            rememberSessionAccessKey(code, desiredAccessKey);
            rememberSessionHostWriteKey(code, newHostWriteKey);
            sessionTrace('deferred.enable.success', { roomCode: code });
            return true;
        } catch (e) {
            sessionTrace('deferred.enable.error', { roomCode: code, message: (e && e.message) || String(e) });
            return false;
        }
    })().finally(() => {
        deferredCodeOnlyEnablePromise = null;
        deferredCodeOnlyEnableRoom = null;
    });

    return deferredCodeOnlyEnablePromise;
}

// Tentative de reprise à froid avec le SEUL code à 4 chiffres. Elle ne réussit que pour
// une salle que l'hôte a explicitement convertie au mode différé ci-dessus ; une salle live
// garde une clé aléatoire et répondra donc 401/403, sans révéler son état.
async function pullDeferredSessionStateByCode(roomCode) {
    if (isLocalFileSessionMode()) return null;
    sessionTrace('cloud.cold-pull.begin', { roomCode: normalizeSessionRoomCode(roomCode) });
    const code = normalizeSessionRoomCode(roomCode);
    const accessKey = deferredCodeOnlyAccessKey(code);
    if (!code || !accessKey) return null;
    try {
        const resp = await fetch(sessionApiUrl(code), {
            method: 'GET',
            cache: 'no-store',
            headers: { 'X-Bridge-Session-Key': accessKey }
        });
        if (resp.status === 401 || resp.status === 403 || resp.status === 404) return null;
        if (!resp.ok) throw new Error(`pullDeferredSessionStateByCode: HTTP ${resp.status}`);
        rememberSessionAccessKey(code, accessKey);
        const body = await resp.json();
        sessionTrace('cloud.cold-pull.success', { roomCode: code, version: body && body.version });
        return body;
    } catch (e) {
        sessionTrace('cloud.cold-pull.error', { roomCode: code, message: (e && e.message) || String(e) });
        return null;
    }
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
    sessionTrace('room.reserve.begin');
    resp = await requestLight(`${SESSION_API_BASE}/api/reserve-code`);
    if (resp.status === 404 || resp.status === 405) {
        // Compat uniquement avec un backend réellement ancien. Une erreur RÉSEAU du petit
        // endpoint n'est plus doublée par un second appel lourd au même Vercel : cela
        // fabriquait précisément de très longues valeurs aberrantes lors des incidents.
        perf('reserve-legacy-fallback');
        resp = await requestLegacy(`${SESSION_API_BASE}/api/session`, { action: 'reserve-code' });
    }

    perf('reserve-response', { status: resp.status });
    sessionTrace('room.reserve.response', { status: resp.status });
    if (!resp.ok) throw new Error(`reserveFreshRoomCode: HTTP ${resp.status}`);
    const body = await resp.json();
    const code = body && String(body.code || '').trim();
    if (!/^\d{4}$/.test(code)) {
        sessionTrace('room.reserve.invalid-code', { receivedLength: code.length });
        throw new Error('reserveFreshRoomCode: réponse serveur invalide');
    }
    sessionTrace('room.reserve.success', { roomCode: code });
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
    const code = normalizeSessionRoomCode(roomCode);
    const resp = await fetchWithSessionCapability(code, sessionApiUrl(code), { method: 'GET', cache: 'no-store' });
    if (resp.status === 404) return null;
    if (!resp.ok) {
        sessionTrace('cloud.pull.error', { roomCode: code, status: resp.status });
        throw new Error(`pullSessionState: HTTP ${resp.status}`);
    }
    const body = await resp.json();
    sessionTrace('cloud.pull.success', { roomCode: code, version: body && body.version });
    return body;
}

async function pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft = SESSION_PUSH_RETRIES, participantCredential = null } = {}) {
    if (isLocalFileSessionMode()) return null;
    try {
        const code = normalizeSessionRoomCode(roomCode);
        sessionTrace('cloud.push.begin', { roomCode: code, expectedVersion, participantWrite: !!participantCredential, retriesLeft });
        const headers = { 'Content-Type': 'application/json' };
        // R19 — une écriture explicitement participant doit RESTER participant, même si
        // ce navigateur possède aussi une clé hôte dans localStorage (deux onglets du même
        // profil partagent ce stockage). L'ancien ordre donnait priorité à hostWriteKey et
        // pouvait transformer silencieusement un PUT restreint en PUT hôte complet.
        const hasExplicitParticipantCredential = !!(participantCredential
            && participantCredential.participantId
            && participantCredential.reconnectSecret);
        const hostWriteKey = getSessionHostWriteKey(code);
        if (hasExplicitParticipantCredential) {
            headers['X-Bridge-Participant-Id'] = participantCredential.participantId;
            headers['X-Bridge-Reconnect-Secret'] = participantCredential.reconnectSecret;
        } else if (hostWriteKey) {
            headers['X-Bridge-Host-Write-Key'] = hostWriteKey;
        }
        const resp = await fetchWithSessionCapability(roomCode, sessionApiUrl(roomCode), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ state, expectedVersion }),
            keepalive: true
        });
        if (resp.status === 409) {
            const body = await resp.json().catch(() => null);
            sessionTrace('cloud.push.conflict', { roomCode: code, expectedVersion, currentVersion: body && body.current && body.current.version });
            if (onConflict) onConflict(body && body.current);
            return null;
        }
        if (!resp.ok) throw new Error(`pushSessionState: HTTP ${resp.status}`);
        const body = await resp.json();
        sessionTrace('cloud.push.success', { roomCode: code, version: body && body.version, participantWrite: !!participantCredential });
        return body;
    } catch (err) {
        if (retriesLeft > 0) {
            sessionTrace('cloud.push.retry', { roomCode: normalizeSessionRoomCode(roomCode), retriesLeft, message: (err && err.message) || String(err) });
            await new Promise(r => setTimeout(r, SESSION_PUSH_RETRY_DELAY_MS));
            return pushSessionState(roomCode, state, expectedVersion, { onConflict, retriesLeft: retriesLeft - 1, participantCredential });
        }
        sessionTrace('cloud.push.failed', { roomCode: normalizeSessionRoomCode(roomCode), message: (err && err.message) || String(err) });
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
        deferredCodeOnlyAccessKey, deferredCodeOnlyParticipantCredential,
        enableDeferredCodeOnlyRoomAccess, pullDeferredSessionStateByCode,
        claimLegacySessionAccess, activateRoomAccess, rotateSessionCapabilities
    };
}
