'use strict';

// Gate de régression : copie du lien d'invitation, y compris Safari mobile
// sans Clipboard API ou avec une permission clipboard refusée.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('let copyShareLinkTimeoutId = null;');
const end = source.indexOf("// ===== Salon d'attente =====", start);
assert(start >= 0 && end > start, 'Bloc de copie du lien introuvable');
const block = source.slice(start, end);

async function scenario(options = {}) {
    const btn = { textContent: '🔗 Copier lien de connexion' };
    const gameBtn = { textContent: '🔗' };
    const input = { value: options.link === undefined ? 'https://exemple.test/PLAY/?room=1234' : options.link };
    const prompts = [];
    const calls = [];
    const timeouts = new Map();
    let nextTimeout = 1;
    const nodes = [];
    const document = {
        body: {
            appendChild(el) { nodes.push(el); },
            removeChild(el) {
                const i = nodes.indexOf(el);
                assert(i !== -1, 'élément temporaire non ajouté');
                nodes.splice(i, 1);
            }
        },
        getElementById(id) {
            return { shareLinkInput: input, copyShareLinkBtn: btn }[id] || null;
        },
        createElement(tag) {
            assert.strictEqual(tag, 'textarea');
            return { style: {}, focus() {}, select() {}, setSelectionRange() {} };
        },
        execCommand(command) {
            assert.strictEqual(command, 'copy');
            calls.push('legacy');
            if (options.legacyThrows) throw new Error('copy refused');
            return !!options.legacyWorks;
        }
    };
    const clipboard = options.clipboard === 'absent' ? undefined : {
        writeText(link) {
            calls.push('modern');
            assert.strictEqual(link, 'https://exemple.test/PLAY/?room=1234');
            if (options.clipboard === 'reject') return Promise.reject(new Error('NotAllowedError'));
            if (options.clipboard === 'throw') throw new Error('NotAllowedError');
            return Promise.resolve();
        }
    };
    const context = {
        document,
        navigator: clipboard ? { clipboard } : {},
        window: { prompt(message, link) { prompts.push({ message, link }); } },
        currentRoomCode: options.roomCode === undefined ? '1234' : options.roomCode,
        buildRoomShareUrl(code) {
            assert.strictEqual(code, '1234');
            return { toString: () => 'https://exemple.test/PLAY/?room=1234' };
        },
        setTimeout(fn) { const id = nextTimeout++; timeouts.set(id, fn); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        Promise
    };
    vm.createContext(context);
    vm.runInContext(block, context, { filename: 'app.js / partage' });
    vm.runInContext('uiCopyShareLink(document.getElementById("copyShareLinkBtn"))', context);
    await new Promise(resolve => setImmediate(resolve));
    return {
        btn, gameBtn, input, prompts, calls, nodes, timeouts, context
    };
}

(async () => {
    let s = await scenario();
    assert.deepStrictEqual(s.calls, ['modern']);
    assert.strictEqual(s.btn.textContent, '✅ Lien copié !');
    assert.strictEqual(s.prompts.length, 0);

    s = await scenario({ clipboard: 'absent', legacyWorks: true });
    assert.deepStrictEqual(s.calls, ['legacy']);
    assert.strictEqual(s.btn.textContent, '✅ Lien copié !');
    assert.strictEqual(s.nodes.length, 0);

    s = await scenario({ clipboard: 'reject', legacyWorks: true });
    assert.deepStrictEqual(s.calls, ['modern', 'legacy']);
    assert.strictEqual(s.btn.textContent, '✅ Lien copié !');

    s = await scenario({ clipboard: 'throw', legacyWorks: false });
    assert.deepStrictEqual(s.calls, ['modern', 'legacy']);
    assert.strictEqual(s.prompts.length, 1);
    assert(s.prompts[0].link.includes('room=1234'));
    assert.strictEqual(s.btn.textContent, '⚠️ Copie manuelle');

    s = await scenario({ clipboard: 'absent', legacyThrows: true });
    assert.strictEqual(s.prompts.length, 1);
    assert.strictEqual(s.nodes.length, 0);

    s = await scenario({ link: '' });
    assert.strictEqual(s.input.value, 'https://exemple.test/PLAY/?room=1234');
    assert.strictEqual(s.btn.textContent, '✅ Lien copié !');

    s = await scenario({ link: '', roomCode: '' });
    assert.deepStrictEqual(s.calls, []);
    assert.strictEqual(s.btn.textContent, '⚠️ Lien indisponible');

    // Double clic et changement de bouton : libellés initiaux restaurés.
    s = await scenario();
    vm.runInContext('uiCopyShareLink(document.getElementById("copyShareLinkBtn"))', s.context);
    await new Promise(resolve => setImmediate(resolve));
    for (const fn of s.timeouts.values()) fn();
    assert.strictEqual(s.btn.textContent, '🔗 Copier lien de connexion');

    console.log('PLAY : copie du lien mobile gate PASS');
})().catch(err => { console.error(err); process.exitCode = 1; });
