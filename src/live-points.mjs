const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const states=new Set(['ITEM_ACTIVE','OUTRO_ACTIVE','VESTED','FORFEITED']);
const transitions={ITEM_ACTIVE:new Set(['ITEM_ACTIVE','OUTRO_ACTIVE','FORFEITED']),
  OUTRO_ACTIVE:new Set(['OUTRO_ACTIVE','VESTED','FORFEITED']),VESTED:new Set(['VESTED']),FORFEITED:new Set(['FORFEITED'])};
function amount(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||v.length>80)throw Error('invalid points');return BigInt(v);}
function validate(v){
  if(!v||typeof v!=='object'||![v.artistId,v.occurrenceId].every(x=>typeof x==='string'&&id.test(x))||
    !Number.isSafeInteger(v.sequence)||v.sequence<1||!states.has(v.phase)||
    typeof v.speakerVerified!=='boolean'||typeof v.outroComplete!=='boolean'||
    typeof v.interrupted!=='boolean')throw Error('invalid issuer event');
  const provisional=amount(v.provisional),spendable=amount(v.spendable);
  if((v.phase==='VESTED'&&(!v.outroComplete||provisional!==0n))||
    (v.phase==='FORFEITED'&&(!v.interrupted||provisional!==0n))||
    (!v.speakerVerified&&provisional!==0n))
    throw Error('inconsistent issuer event');
  return {provisional,spendable};
}
/** Display projection only; an authenticated DRE-18 issuer owns accrual and atomic spend. */
export class LivePointsView{
  constructor(){this.byArtist=new Map();this.occurrences=new Map();}
  ingestTrusted(event){
    const {provisional,spendable}=validate(event);
    const key=`${event.artistId}\0${event.occurrenceId}`;
    const previous=this.occurrences.get(key);
    if(previous&&(event.sequence<=previous.sequence||!transitions[previous.phase].has(event.phase)))
      throw Error('stale or invalid point transition');
    const priorWallet=this.byArtist.get(event.artistId);
    if(priorWallet&&event.sequence<=priorWallet.sequence)throw Error('stale artist wallet');
    this.occurrences.set(key,{phase:event.phase,sequence:event.sequence});
    this.byArtist.set(event.artistId,Object.freeze({artistId:event.artistId,occurrenceId:event.occurrenceId,
      phase:event.phase,provisional:provisional.toString(),spendable:spendable.toString(),
      speakerVerified:event.speakerVerified,sequence:event.sequence}));
    return this.view(event.artistId);
  }
  view(artistId){
    if(typeof artistId!=='string'||!id.test(artistId))throw Error('invalid artist');
    return this.byArtist.get(artistId)??Object.freeze({artistId,occurrenceId:null,phase:'UNKNOWN',
      provisional:'0',spendable:'0',speakerVerified:false,sequence:0});
  }
}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export function renderLivePoints(view){
  if(!view||typeof view.artistId!=='string'||!id.test(view.artistId)||
    !new Set([...states,'UNKNOWN']).has(view.phase))throw Error('invalid view');
  const provisional=amount(view.provisional),spendable=amount(view.spendable);
  if(typeof view.speakerVerified!=='boolean'||!Number.isSafeInteger(view.sequence)||
    (view.phase==='UNKNOWN'?(view.occurrenceId!==null||view.sequence!==0||
      provisional!==0n||spendable!==0n):
      (typeof view.occurrenceId!=='string'||!id.test(view.occurrenceId)||view.sequence<1))||
    ((view.phase==='VESTED'||view.phase==='FORFEITED')&&provisional!==0n)||
    (!view.speakerVerified&&provisional!==0n))throw Error('invalid view');
  return `<section aria-labelledby="points-title"><h2 id="points-title">${esc(view.artistId)} artist points</h2>`+
    `<p>Provisional this broadcast: ${provisional}. Spendable: ${spendable}.</p>`+
    `<p role="status" aria-live="polite">${view.phase==='VESTED'?'Issuer reports outro complete and points vested':
      view.phase==='FORFEITED'?'Interrupted broadcast: provisional points forfeited':
      view.phase==='OUTRO_ACTIVE'?'Closing identification in progress; points are not yet spendable':
      view.phase==='ITEM_ACTIVE'?'Broadcast in progress; points are provisional':'No verified point event'}</p>`+
    `<p>Headphones and unverified output earn no speaker points. Only the issuer can grant or spend.</p></section>`;
}
