const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
/** Consumer animation only. DRE authenticates transition, completion and grant. */
export class GrooveReveal{
 #scope;#verifyTransition;#verifyGrant;#claim;#change;#now;#active=null;#closed=false;#generation=0;
 constructor({scope,verifyTransition,verifyGrant,claimReveal,onChange,now=Date.now}={}){
  this.#scope=Object.freeze(Object.fromEntries(['tenantId','applicationId','stationId','listenerId'].map(k=>{if(!validId(scope?.[k]))throw Error('Scoped listener required');return[k,scope[k]];})));
  if(![verifyTransition,verifyGrant,claimReveal,onChange,now].every(fn=>typeof fn==='function'))throw Error('Approved transition/grant verifiers and durable reveal checkpoint required');
  this.#verifyTransition=verifyTransition;this.#verifyGrant=verifyGrant;this.#claim=claimReveal;this.#change=onChange;this.#now=now;
 }
 #time(){const value=this.#now();if(!integer(value))throw Error('Invalid reveal clock');return value;}
 async arm(input){
  if(this.#closed)throw Error('Reveal closed');const marker=structuredClone(input),generation=++this.#generation;
  if(!marker||marker.stationId!==this.#scope.stationId||!validId(marker.opportunityId)||!integer(marker.atMs)||
   marker.eligible!==true||marker.afterOutro!==true||marker.beforeNextIntro!==true||await this.#verifyTransition(marker,this.#scope)!==true)throw Error('Authenticated shared transition required');
  if(this.#closed||generation!==this.#generation)return false;
  if(this.#active?.marker.opportunityId===marker.opportunityId){if(this.#active.marker.atMs!==marker.atMs)throw Error('Conflicting transition');return false;}
  if(this.#active&&marker.atMs<=this.#active.marker.atMs)throw Error('Out-of-order shared transition');
  this.#active={marker,locked:false,unlocked:false,pending:false};this.advance();return true;
 }
 advance(){
  if(this.#closed)return;const active=this.#active,time=this.#time();
  if(!active||time<active.marker.atMs)return;
  if(time-active.marker.atMs>5000){if(active.locked&&!active.expired){active.expired=true;this.#change(Object.freeze({phase:'HIDDEN',label:''}));}return;}
  if(active.locked)return;
  active.locked=true;this.#change(Object.freeze({phase:'LOCKED',label:'LOCKED GROOVE'}));
 }
 async accept(input){
  if(this.#closed)return false;const active=this.#active,result=structuredClone(input),time=this.#time();
  if(!active||active.unlocked||active.pending||time<active.marker.atMs||time-active.marker.atMs>5000)return false;
  const grant=result?.grant;
  if(result?.state!=='granted'||result.opportunityId!==active.marker.opportunityId||result.atMs!==active.marker.atMs||
   result.stationId!==this.#scope.stationId||result.listenerId!==this.#scope.listenerId||!grant||
   ['tenantId','applicationId','listenerId'].some(k=>grant[k]!==this.#scope[k])||!validId(grant.grantId)||
   !validId(grant.grooveId)||grant.grooveId!==result.grooveId||await this.#verifyGrant(result,this.#scope,active.marker)!==true)throw Error('Authenticated matching Groove grant required');
  if(this.#closed||this.#active!==active||active.pending||active.unlocked)return false;
  active.pending=true;
  try{
   const claimed=await this.#claim(Object.freeze({...this.#scope,opportunityId:result.opportunityId,grantId:grant.grantId}));
   const current=this.#time();if(claimed!==true||this.#closed||this.#active!==active||current<active.marker.atMs||current-active.marker.atMs>5000)return false;
   this.advance();active.unlocked=true;this.#change(Object.freeze({phase:'UNLOCKED',label:'UNLOCKED GROOVE'}));return true;
  }finally{active.pending=false;}
 }
 close(){this.#closed=true;this.#active=null;++this.#generation;}
}
export const grooveRevealCss=`.groove-reveal{font:700 1.15rem system-ui;color:#132c25;background:#e5f6ed;padding:1rem;border:2px solid #226144;border-radius:.5rem}.groove-reveal[data-phase="UNLOCKED"]{animation:groove-unlock 450ms ease-out}@keyframes groove-unlock{from{transform:translateY(.25rem);opacity:.3}to{transform:none;opacity:1}}@media(prefers-reduced-motion:reduce){.groove-reveal[data-phase="UNLOCKED"]{animation:none}}`;
/** Non-modal polite announcement; never changes focus or calls a playback API. */
export function mountGrooveReveal(container){
 if(!container?.ownerDocument||typeof container.append!=='function')throw Error('DOM container required');
 const node=container.ownerDocument.createElement('p');node.className='groove-reveal';node.setAttribute('role','status');node.setAttribute('aria-live','polite');node.setAttribute('aria-atomic','true');node.hidden=true;container.append(node);
 return Object.freeze({update(state){if(state?.phase==='HIDDEN'){node.hidden=true;node.textContent='';return;}if(!['LOCKED','UNLOCKED'].includes(state?.phase))throw Error('Invalid reveal phase');node.dataset.phase=state.phase;node.textContent=state.phase==='LOCKED'?'LOCKED GROOVE':'UNLOCKED GROOVE';node.hidden=false;},remove(){node.remove();}});
}
