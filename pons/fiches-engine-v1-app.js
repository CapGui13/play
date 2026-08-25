// fiches-engine-v1-app.js — adaptateur de l'application historique vers le runtime canonique v1.
(function(root){
  'use strict';
  const VERSION='canonical-v1.4-dev';
  const api=root.BridgeBiddingV1;
  const rules=Array.isArray(root.BRIDGE_CANONICAL_RULES_V1)?root.BRIDGE_CANONICAL_RULES_V1:[];
  if(!api||!api.BiddingEngineV1) throw new Error('bridge-engine-v1-browser.js non chargé');
  if(!rules.length) throw new Error('canonical-rules-v1.js non chargé');
  const engine=new api.BiddingEngineV1(rules,{ambiguityMargin:8});

  function historyToAuction(history){return (history||[]).map(x=>typeof x==='string'?x:(x&&x.call)).filter(Boolean);}
  function toAppCall(raw){
    const b=api.normalizeBid(raw); if(b==='P')return 'PASS'; if(b==='X'||b==='XX')return b;
    const m=b&&b.match(/^([1-7])([CDHSN])$/); if(!m)return 'PASS'; return `${m[1]}${m[2]==='N'?'NT':m[2]}`;
  }
  function seatIndex(seat){return ({N:0,E:1,S:2,W:3})[String(seat||'').toUpperCase()]??0;}
  function isSeatVulnerable(seat,v){const s=String(seat||'').toUpperCase(),vul=String(v||'None');if(vul==='Both')return true;if(vul==='None')return false;return ((s==='N'||s==='S')?'NS':'EW')===vul;}
  function compactKnowledge(k){
    const p=k&&k.lastPartner; if(!p)return '';
    const suits=Object.entries(p.guaranteed?.suits||{}).map(([s,b])=>`${s}≥${b.min??'?'}`).join(',');
    const pts=Object.entries(p.guaranteed?.points||{}).map(([m,b])=>`${m}≥${b.min??'?'}`).join(',');
    const x=[suits,pts].filter(Boolean).join(' ; '); return x?` · partenaire: ${x}`:'';
  }
  function formatExplanation(result,hand){
    const src=result.source?` · source ${result.source}`:'';
    const seq=result.sequence?` · fiche ${result.sequence}`:'';
    const conf=` · confiance ${Math.round((result.confidence||0)*100)}%`;
    const uni=result.universe?` · univers ${result.universe}`:'';
    const res=result.resolution?` · ${result.resolution}`:'';
    const reasons=(result.reason||[]).join(' ; ');
    const k=compactKnowledge(result.diagnostics&&result.diagnostics.knowledge);
    return `Moteur ${VERSION} — ${api.displayBid(result.bid)} (${hand.hcp}H/${hand.hl}HL) : ${reasons}${src}${seq}${uni}${res}${conf}${k}`;
  }
  function runCanonicalDecision(seat,deal,history,pointShift=0){
    const actualHand=api.parseHand(deal&&deal.hands?deal.hands[seat]:null),auction=historyToAuction(history);
    // Pour la variante 1SA 12-14, on ne touche jamais aux cartes, longueurs, arrêts ou
    // contrôles : seuls H/HL/HLD sont vus 3 points plus haut par les règles standard.
    // C'est exactement équivalent à descendre de 3H tous les seuils de la branche 1SA.
    const hand=pointShift ? {...actualHand,hcp:actualHand.hcp+pointShift,hl:actualHand.hl+pointShift} : actualHand;
    const context={seat:seatIndex(seat),vulnerable:isSeatVulnerable(seat,deal&&deal.vulnerable),board:Number(deal&&deal.board)||null};
    const result=engine.chooseBid({hand,auction,context,trace:true}); let appCall=toAppCall(result.bid);
    if(typeof root.isCallLegal==='function'&&!root.isCallLegal(history||[],appCall,seat)){
      appCall='PASS'; result.reason=[...(result.reason||[]),'Annonce rejetée par la légalité de l’application : repli sur Passe.']; result.confidence=0; result.resolution='app-legality-fallback';
    }
    const prefix=pointShift ? 'Mode 1SA faible 12–14H — seuils de la branche 1SA décalés de −3H. ' : '';
    let rendered=formatExplanation(result,actualHand);
    // Le journal canonique décrit naturellement l'ouverture standard comme 15-17H.
    // En mode faible cette ligne de connaissance serait trompeuse pour l'utilisateur,
    // même si elle est justement utilisée en interne comme repère virtuel +3.
    if(pointShift) rendered=rendered.replace(/ · partenaire:.*$/,'');
    return {call:appCall,explanation:prefix+rendered};
  }
  function decideRobotCall(seat,deal,history){
    try{return runCanonicalDecision(seat,deal,history,0);}
    catch(err){console.error(`[${VERSION}]`,err);return {call:'PASS',explanation:`Moteur ${VERSION} — erreur interne : ${err?.message||String(err)}. Repli sur Passe.`};}
  }
  function decideRobotCallShortNT(seat,deal,history){
    try{return runCanonicalDecision(seat,deal,history,3);}
    catch(err){console.error(`[${VERSION}/short-nt]`,err);return {call:'PASS',explanation:`Mode 1SA faible 12–14H — erreur interne : ${err?.message||String(err)}. Repli sur Passe.`};}
  }
  root.decideRobotCall=decideRobotCall;
  root.decideRobotCallShortNT=decideRobotCallShortNT;
  root.BRIDGE_ENGINE_VERSION=VERSION;
  root.FichesBiddingEngine={version:VERSION,rulesCount:rules.length,engine,decideRobotCall,decideRobotCallShortNT,chooseBid:o=>engine.chooseBid(o),classifyAuction:a=>api.classifyAuction(historyToAuction(a)),getRulesForAuction:a=>engine.getRules(historyToAuction(a)),knowledge:a=>engine.knowledge(historyToAuction(a))};
  console.info(`[${VERSION}] ${rules.length} règles canoniques chargées.`);
})(typeof window!=='undefined'?window:globalThis);
