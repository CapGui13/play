// dealer-par.js — port JavaScript du DealerPar DDS pour PLAY.
// Dérivé de dds-bridge/dds library/src/dealer_par.cpp.
// Copyright DDS : 2006-2014 Bo Haglund ; 2014-2018 Bo Haglund & Soren Hein.
// Licence Apache-2.0. Modifié dans PLAY R37 pour exposer DealerPar depuis une table DD JS.
(function(root, factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.PlayDealerPar=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DOUBLED_SCORES=[
    [0,100,300,500,800,1100,1400,1700,2000,2300,2600,2900,3200,3500],
    [0,200,500,800,1100,1400,1700,2000,2300,2600,2900,3200,3500,3800]
  ];
  const SCORES=[
    [0,0],[70,70],[70,70],[80,80],[80,80],[90,90],
    [90,90],[90,90],[110,110],[110,110],[120,120],
    [110,110],[110,110],[140,140],[140,140],[400,600],
    [130,130],[130,130],[420,620],[420,620],[430,630],
    [400,600],[400,600],[450,650],[450,650],[460,660],
    [920,1370],[920,1370],[980,1430],[980,1430],[990,1440],
    [1440,2140],[1440,2140],[1510,2210],[1510,2210],[1520,2220]
  ];
  const DOWN_TARGET=[
    [0,0,0,0],
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],
    [0,0,0,0],[0,0,0,0],[1,0,1,0],[1,0,1,0],[1,0,1,0],
    [1,0,1,0],[1,0,1,0],[1,0,1,0],[1,0,1,0],[2,1,3,2],
    [1,0,1,0],[1,0,1,0],[2,1,3,2],[2,1,3,2],[2,1,3,2],
    [2,1,3,2],[2,1,3,2],[2,1,3,2],[2,1,3,2],[2,1,3,2],
    [4,3,5,4],[4,3,5,4],[4,3,6,5],[4,3,6,5],[4,3,6,5],
    [6,5,8,7],[6,5,8,7],[6,5,8,7],[6,5,8,7],[6,5,8,7]
  ];
  const FLOOR_CONTRACT=[0,1,2,3,4,5,1,2,3,4,5,1,2,3,4,15,1,2,18,19,15,21,22,18,19,15,26,27,28,29,30,31,32,33,34,35];
  const NUMBER_TO_CONTRACT=['0','1C','1D','1H','1S','1N','2C','2D','2H','2S','2N','3C','3D','3H','3S','3N','4C','4D','4H','4S','4N','5C','5D','5H','5S','5N','6C','6D','6H','6S','6N','7C','7D','7H','7S','7N'];
  const PLAYERS=['N','E','S','W'];
  const VUL_LOOKUP=[[0,0],[1,1],[1,0],[0,1]]; // none,both,NS,EW
  const VUL_TO_NO=[[0,1],[2,3]];
  const PAR_DENOMS=['C','D','H','S','N'];
  const TABLE_DENOMS=['S','H','D','C','N'];
  const DENOM_ORDER=[3,2,1,0,4];
  const BIGNUM=9999;

  function vulCode(v){ return v==='Both'?1:(v==='NS'?2:(v==='EW'?3:0)); }
  function dealerCode(d){ const i=PLAYERS.indexOf(String(d||'N').toUpperCase()); return i<0?0:i; }
  function matrix(table){
    return TABLE_DENOMS.map(str=>PLAYERS.map(p=>Number(table&&table[str]&&table[str][p])));
  }
  function surveyScores(t,dealer,vulBySide){
    const list=[Array(5),Array(5)], stats=[{},{}];
    for(let side=0;side<=1;side++){
      let highest=0,dearestNo=0,dearestScore=0;
      for(let dno=0;dno<5;dno++){
        const row=t[DENOM_ORDER[dno]], a=row[side], b=row[side+2], best=Math.max(a,b);
        const no=5*(best-7)+dno+1;
        const cell={score:0,dno,no,tricks:best,down:0}; list[side][dno]=cell;
        if(best<7) continue;
        const score=SCORES[no][vulBySide[side]]; cell.score=score;
        if(score>dearestScore){dearestScore=score;dearestNo=no;}
        else if(score===dearestScore&&no<dearestNo) dearestNo=no;
        if(no>highest) highest=no;
      }
      stats[side]={highest_making_no:highest,dearest_making_no:dearestNo,dearest_score:dearestScore};
    }
    const s0=stats[0].highest_making_no,s1=stats[1].highest_making_no;
    let primacy=0;
    if(s0>s1) primacy=0; else if(s0<s1) primacy=1; else if(s0===0) return {primacy:-1,list,numCandidates:0};
    else {
      const dno=(s0-1)%5,tmax=list[0][dno].tricks,row=t[DENOM_ORDER[dno]];
      for(let p=dealer;p<=dealer+3;p++){ if(row[p%4]===tmax){primacy=p%2;break;} }
    }
    const st=stats[primacy], vulNo=VUL_TO_NO[vulBySide[primacy]][vulBySide[1-primacy]];
    list[primacy].sort((a,b)=>b.no-a.no);
    let numCandidates=5;
    for(let n=0;n<5;n++) if(list[primacy][n].no<st.dearest_making_no) numCandidates--;
    return {primacy,highest_making_no:st.highest_making_no,dearest_making_no:st.dearest_making_no,dearest_score:st.dearest_score,vul_no:vulNo,list,numCandidates};
  }
  function bestSacrifice(t,side,no,dno,dealer,list,sacrTable){
    const other=1-side,sacrList=list[other]; let bestDown=BIGNUM;
    for(let eno=0;eno<=4;eno++){
      const sacr=sacrList[eno]; let down=BIGNUM;
      if(eno===dno){
        const tmax=Math.trunc((no+34)/5),row=t[DENOM_ORDER[dno]]; let incr=0;
        for(let p=dealer;p<=dealer+3;p++){
          const diff=tmax-row[p%4],s=p%2;
          if(s===side){if(diff===0) incr=1;} else {const local=diff+incr;if(local<down) down=local;}
        }
        if(sacr.no+5*down>35) down=BIGNUM;
      } else {
        down=Math.trunc((no-sacr.no+4)/5); if(sacr.no+5*down>35) down=BIGNUM;
      }
      sacrTable[dno][eno]=down; if(down<bestDown) bestDown=down;
    }
    return bestDown;
  }
  function reduceContract(no,sacGap){
    if(sacGap>=-1) return {no,plus:0};
    const flr=FLOOR_CONTRACT[no], noSacLevel=no+5*(sacGap+1), newNo=Math.max(noSacLevel,flr);
    return {no:newNo,plus:(no-newNo)/5};
  }
  function contractAsText(t,side,no,dno,delta){
    const row=t[DENOM_ORDER[dno]],ta=row[side],tb=row[side+2],mx=Math.max(ta,tb);
    return NUMBER_TO_CONTRACT[no]+(delta<0?'*-':'-')+(ta===mx?PLAYERS[side]:'')+(tb===mx?PLAYERS[side+2]:'')+(delta>0?'+':'')+(delta===0?'':String(delta));
  }
  function sacrificeAsText(no,pno,down){ return NUMBER_TO_CONTRACT[no]+'-'+PLAYERS[pno]+'-'+down; }
  function sacrificesAsText(t,side,dealer,bestDown,noDecl,dno,list,sacr){
    const out=[],other=1-side,sacrList=list[other];
    for(let eno=0;eno<=4;eno++){
      let down=sacr[dno][eno]; if(down!==bestDown) continue;
      if(eno!==dno){ out.push(contractAsText(t,other,sacrList[eno].no+5*bestDown,eno,-bestDown)); continue; }
      const tmax=Math.trunc((noDecl+34)/5),row=t[DENOM_ORDER[dno]]; let incr=0;
      const pnos=[],sacs=[];
      for(let p=dealer;p<=dealer+3;p++){
        const pm=p%4,diff=tmax-row[pm],s=p%2;
        if(s===side){if(diff===0) incr=1;} else {down=diff+incr;if(down!==bestDown) continue;pnos.push(pm);sacs.push(noDecl+5*incr);}
      }
      if(pnos.length===1){out.push(sacrificeAsText(sacs[0],pnos[0],bestDown));continue;}
      if(pnos.length>=2&&sacs[0]===sacs[1]){out.push(contractAsText(t,other,sacs[0],eno,-bestDown));continue;}
      if(pnos.length>=2){const p=sacs[0]<sacs[1]?0:1;out.push(sacrificeAsText(sacs[p],pnos[p],bestDown));}
    }
    return out;
  }
  function parseContractText(raw){
    if(raw==='pass') return {raw,passout:true,level:0,strain:null,declarer:null,doubled:''};
    const m=String(raw).match(/^([1-7])([CDHSN])(\*)?-(NS|EW|N|E|S|W)([+-]\d+)?$/);
    if(!m) return {raw};
    const delta=m[5]?Number(m[5]):0;
    return {raw,passout:false,level:Number(m[1]),strain:m[2],declarer:m[4],doubled:(m[3]||delta<0)?'X':'',delta};
  }
  function dealerPar(table,dealer,vulnerability){
    const t=matrix(table),vul=VUL_LOOKUP[vulCode(vulnerability)],d=dealerCode(dealer),data=surveyScores(t,d,vul);
    if(data.primacy===-1) return {score:0,contracts:[parseContractText('pass')],rawContracts:['pass']};
    const side=data.primacy,lists=data.list[side],types=[],sacGap=[],sacr=Array.from({length:5},()=>Array(5).fill(0));
    let bestPlus=0,sacFound=false,bestDown=0;
    for(let n=0;n<data.numCandidates;n++){
      const no=lists[n].no,dno=lists[n].dno,target=DOWN_TARGET[no][data.vul_no];
      const down=bestSacrifice(t,side,no,dno,d,data.list,sacr);
      if(down<=target){ if(down>bestDown) bestDown=down; if(sacFound) types[n]=-1; else {sacFound=true;types[n]=0;lists[n].down=down;} }
      else {if(lists[n].score>bestPlus) bestPlus=lists[n].score;types[n]=1;sacGap[n]=target-down;}
    }
    const sac=DOUBLED_SCORES[vul[1-side]][bestDown]; let raws=[],score;
    if(!sacFound||bestPlus>sac){
      score=side===0?bestPlus:-bestPlus;
      for(let n=0;n<data.numCandidates;n++) if(types[n]===1&&lists[n].score===bestPlus){const r=reduceContract(lists[n].no,sacGap[n]);raws.push(contractAsText(t,side,r.no,lists[n].dno,r.plus));}
    } else {
      const sacScore=DOUBLED_SCORES[vul[1-side]][bestDown]; score=side===0?sacScore:-sacScore;
      for(let n=0;n<data.numCandidates;n++) if(types[n]===0&&lists[n].down===bestDown) raws.push(...sacrificesAsText(t,side,d,bestDown,lists[n].no,lists[n].dno,data.list,sacr));
    }
    return {score,contracts:raws.map(parseContractText),rawContracts:raws};
  }
  function vulnerableForSeat(v,seat){return v==='Both'||v===(seat==='N'||seat==='S'?'NS':'EW');}
  function duplicateContractScore(table,contract,vulnerability){
    if(!contract) return 0;
    const strain=contract.strain==='NT'?'N':contract.strain, tricks=Number(table&&table[strain]&&table[strain][contract.declarer]);
    if(!Number.isFinite(tricks)) return null;
    const target=contract.level+6, delta=tricks-target, vul=vulnerableForSeat(vulnerability,contract.declarer), mult=contract.doubled==='XX'?4:(contract.doubled==='X'?2:1);
    let declScore=0;
    if(delta>=0){
      const base=strain==='N'?(40+30*(contract.level-1)):(contract.level*(strain==='C'||strain==='D'?20:30));
      const contractPts=base*mult;
      declScore+=contractPts;
      if(mult===2) declScore+=50; else if(mult===4) declScore+=100;
      if(delta>0){ if(mult===1) declScore+=delta*(strain==='C'||strain==='D'?20:30); else if(mult===2) declScore+=delta*(vul?200:100); else declScore+=delta*(vul?400:200); }
      declScore+=(contractPts>=100?(vul?500:300):50);
      if(contract.level===6) declScore+=vul?750:500; else if(contract.level===7) declScore+=vul?1500:1000;
    } else {
      const u=-delta;
      if(mult===1) declScore=-u*(vul?100:50);
      else { let pen; if(vul) pen=200+(u-1)*300; else if(u===1) pen=100; else if(u===2) pen=300; else if(u===3) pen=500; else pen=500+(u-3)*300; declScore=-pen*(mult===4?2:1); }
    }
    return (contract.declarer==='N'||contract.declarer==='S')?declScore:-declScore;
  }
  return {dealerPar,duplicateContractScore,parseContractText,vulCode,dealerCode};
});
