'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'ui-events.js'), 'utf8');

function extractFunction(name) {
    const start = app.indexOf('function ' + name + '(');
    assert(start >= 0, name + ' introuvable');
    const brace = app.indexOf('{', start);
    let depth = 0, quote = null, escape = false, line = false, comment = false;
    for (let i = brace; i < app.length; i++) {
        const c = app[i], n = app[i + 1];
        if (line) { if (c === '\n') line = false; continue; }
        if (comment) { if (c === '*' && n === '/') { comment = false; ++i; } continue; }
        if (quote) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && n === '/') { line = true; ++i; continue; }
        if (c === '/' && n === '*') { comment = true; ++i; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') ++depth;
        if (c === '}' && --depth === 0) return app.slice(start, i + 1);
    }
    throw Error('Fonction incomplète : ' + name);
}
assert(app.includes("'wizz-ack'"), 'Type wizz-ack absent');
assert(app.match(/'wizz-ack'/g).length >= 4, 'Allowlist et handlers ACK manquants');
assert(ui.includes("call('uiSendWizz', el.dataset.participantId || '', el)"), 'Élément cloche non transmis');
assert(css.includes('.wizz-sender-toast') && css.includes('@keyframes wizz-bell-ring'), 'Retour visuel absent');

const functions = [
    'wizzTargetName','showWizzSenderFeedback','animateWizzBell','confirmWizzReceipt',
    'handleIncomingWizz','handleIncomingWizzAck','uiSendWizz','isWizzTargetReachable'
].map(extractFunction).join('\n');

let nextTimer = 1;
const timers = new Map();
const sends = [];
const shown = [];
const senderId = 'host', recipientId = 'g1';
const bell = {
    dataset: {participantId:recipientId},
    offsetWidth: 28,
    classList: {
        values: new Set(),
        add(c) {this.values.add(c);},
        remove(c) {this.values.delete(c);}
    }
};
const el = {
    className: '', id: '', _hideTimer: null,
    classList: {remove() {}, add() {}},
    setAttribute() {}
};
const ctx = {
    Map, Math, Date,
    WIZZ_COOLDOWN_MS: 4000, WIZZ_RECEIPT_WAIT_MS: 5500,
    wizzCooldownUntil: {}, wizzRequestSequence: 0,
    pendingWizzReceipts: new Map(),
    myRole: 'host', myParticipantId: senderId,
    participants: [{id:'host',name:'Hôte'}, {id:'g1',name:'Alice'}, {id:'g2',name:'Bob'}],
    guestIndexByToken:{g1:0,g2:1},
    peerConn:{
        conns:[{open:true},{open:true}],
        isConnected:()=>true,
        send(msg,index){sends.push({msg,index});}
    },
    document: {
        getElementById(){ return el.id==='wizzSenderToast'?el:null; },
        createElement(){return el;},
        body:{appendChild(e){el.id=e.id;}},
        querySelectorAll(){return [bell];}
    },
    setTimeout(fn,ms){const id=nextTimer++;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    pushDebugLog(){},
    authenticatedGuestId:index=>index===0?'g1':'g2',
    rejectPeerProtocolMessage(){throw Error('rejected message');},
    triggerWizzEffect(){ctx.effectCount++;},
    effectCount:0
};
vm.createContext(ctx);
vm.runInContext(functions,ctx);

// Hôte -> invité : état d'envoi immédiat, puis reçu vérifié.
ctx.uiSendWizz('g1',bell);
assert.strictEqual(sends.length,1);
assert.strictEqual(sends[0].index,0);
assert.strictEqual(sends[0].msg.type,'wizz');
assert.strictEqual(el.textContent,'🔔 Wizz envoyé à Alice…');
const requestId=sends[0].msg.requestId;
assert(ctx.pendingWizzReceipts.has(requestId));
ctx.handleIncomingWizzAck({type:'wizz-ack',requestId,senderId:'host',recipientId:'g1'},0);
assert.strictEqual(el.textContent,'✅ Alice a reçu le wizz !');
assert(!ctx.pendingWizzReceipts.has(requestId));

// Double tap sous cooldown : pas de second message.
ctx.uiSendWizz('g1',bell);
assert.strictEqual(sends.length,1);

// Recevoir un ACK de la mauvaise cible ne confirme jamais la bonne.
ctx.uiSendWizz('g2',bell);
const req2=sends.at(-1).msg.requestId;
ctx.handleIncomingWizzAck({type:'wizz-ack',requestId:req2,senderId:'host',recipientId:'g1'},0);
assert(ctx.pendingWizzReceipts.has(req2));

// Hôte relaie correctement le reçu guest2 -> guest1, sans confirmer localement.
ctx.handleIncomingWizzAck({type:'wizz-ack',requestId:'foreign-1',senderId:'g1',recipientId:'g2'},1);
assert.strictEqual(sends.at(-1).index,0);
assert.strictEqual(sends.at(-1).msg.recipientId,'g2');

// Le destinataire traite le wizz, puis seulement envoie son accusé.
ctx.myRole='guest';ctx.myParticipantId='g2';ctx.peerConn={isConnected:()=>true,send(msg){sends.push({msg});}};
const before=sends.length;
ctx.handleIncomingWizz({type:'wizz',targetId:'g2',senderId:'g1',requestId:'abc-123'},0);
assert.strictEqual(ctx.effectCount,1);
assert.strictEqual(sends.length,before+1);
assert.strictEqual(sends.at(-1).msg.type,'wizz-ack');
assert.strictEqual(sends.at(-1).msg.senderId,'g1');
assert.strictEqual(sends.at(-1).msg.recipientId,'g2');

// Si personne ne confirme : le message reste explicite, sans prétendre à un reçu.
ctx.myRole='host';ctx.myParticipantId='host';ctx.peerConn={
 conns:[{open:true},{open:true}],send(msg,index){sends.push({msg,index});}
};
// Avance logique du cooldown pour tester un deuxième envoi indépendant.
ctx.wizzCooldownUntil.g2 = 0;
ctx.uiSendWizz('g2',bell);
const lastId=sends.at(-1).msg.requestId;
const pending=ctx.pendingWizzReceipts.get(lastId);
timers.get(pending.timeoutId).fn();
assert.strictEqual(el.textContent,'⚠️ Pas de confirmation de Bob');
assert(!ctx.pendingWizzReceipts.has(lastId));
// Le bandeau d'envoi est ancré exactement comme celui de réception :
function cssBlock(selector) {
    const begin = css.indexOf(selector + ' {');
    assert(begin >= 0, 'Bloc CSS absent : ' + selector);
    const end = css.indexOf('}', begin);
    assert(end > begin, 'Bloc CSS incomplet : ' + selector);
    return css.slice(begin, end);
}
function cssValue(selector, property) {
    const line = cssBlock(selector).split('\n').find(line => line.trim().startsWith(property + ':'));
    assert(line, property + ' absent dans ' + selector);
    return line.split(':').slice(1).join(':').replace(';', '').trim();
}
for (const [sender, recipient, props] of [
    ['.wizz-sender-toast', '.wizz-toast', ['position', 'top', 'left', 'transform']],
    ['.wizz-sender-toast.visible', '.wizz-toast.visible', ['transform']]
]) {
    for (const prop of props) {
        assert.strictEqual(cssValue(sender, prop), cssValue(recipient, prop),
            'Bandeaux envoi/réception non alignés : ' + prop);
    }
}
assert(!cssBlock('.wizz-sender-toast').includes('bottom:'),
    'Le retour d’envoi ne doit plus s’afficher en bas');

console.log('PLAY : Wizz confirmation P2P/feedback gate PASS');
