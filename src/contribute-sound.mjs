export class ContributionError extends Error{
  constructor(code){super(code);this.code=code;}
}
const labels={OFF:'Off',REQUESTING:'Requesting microphone permission',UNSUPPORTED:'Listening is available; speaker contribution is unavailable on this route',
  READY:'Local measurement is on; contribution still requires verified output evidence',DENIED:'Microphone permission denied',
  INTERRUPTED:'Measurement interrupted'};
/** Consent and eligibility display only; neither a points issuer nor an acoustic meter. */
export class ContributionSetup{
  constructor({requestMic,verifiedRoute,onChange}){
    if(typeof requestMic!=='function'||typeof verifiedRoute!=='function'||typeof onChange!=='function')
      throw new Error('Microphone, trusted route provider and state callback required');
    this.requestMic=requestMic;this.verifiedRoute=verifiedRoute;this.onChange=onChange;
    this.state='OFF';this.stream=null;this.epoch=0;this.notify();
  }
  notify(){this.onChange({state:this.state,label:labels[this.state],pointsEligible:false});}
  async enable(){
    this.disable();const request=++this.epoch;this.state='REQUESTING';this.notify();
    let stream;
    try{
      stream=await this.requestMic({audio:true,video:false});
      if(request!==this.epoch){stream?.getTracks?.().forEach(track=>track.stop());return;}
      if(!stream||typeof stream.getTracks!=='function')throw new ContributionError('INVALID_MIC_STREAM');
      const route=await this.verifiedRoute();
      if(request!==this.epoch){stream.getTracks().forEach(track=>track.stop());return;}
      // A route declaration from the page or a connected-but-unused speaker is not evidence.
      if(!route||route.verified!==true||route.active!==true||!['bluetooth_speaker','wired_speaker'].includes(route.output)){
        stream.getTracks().forEach(track=>track.stop());this.state='UNSUPPORTED';this.notify();return;
      }
      this.stream=stream;
      for(const track of stream.getTracks())track.addEventListener?.('ended',()=>{
        if(request===this.epoch&&this.stream===stream)this.interrupt();
      });
      this.state='READY';this.notify();
    }catch(error){
      stream?.getTracks?.().forEach(track=>track.stop());
      if(request!==this.epoch)return;
      this.state=error?.name==='NotAllowedError'?'DENIED':'INTERRUPTED';this.notify();
    }
  }
  async refreshRoute(){
    if(this.state!=='READY')return;
    const request=this.epoch;
    try{
      const route=await this.verifiedRoute();
      if(request!==this.epoch||this.state!=='READY')return;
      if(!route||route.verified!==true||route.active!==true||!['bluetooth_speaker','wired_speaker'].includes(route.output))
        this.interrupt();
    }catch{
      if(request===this.epoch&&this.state==='READY')this.interrupt();
    }
  }
  interrupt(){
    if(this.state==='OFF')return;
    ++this.epoch;const stream=this.stream;this.stream=null;this.state='INTERRUPTED';
    stream?.getTracks().forEach(track=>track.stop());this.notify();
  }
  disable(){
    ++this.epoch;const stream=this.stream;this.stream=null;this.state='OFF';
    stream?.getTracks().forEach(track=>track.stop());this.notify();
  }
}
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
export function renderContributionSetup(view){
  if(!view||!Object.hasOwn(labels,view.state)||view.label!==labels[view.state]||view.pointsEligible!==false)
    throw new ContributionError('INVALID_CONTRIBUTION_VIEW');
  return `<section aria-labelledby="contribute-title"><h2 id="contribute-title">Contribute Sound</h2>`+
    `<p>Microphone access is optional. Measurement stays on this device by default. Listening works without it.</p>`+
    `<p>Headphones, mute, unsupported routes and unverified speakers earn no speaker points. `+
    `Permission alone never earns points; qualified output evidence and a complete broadcast are required.</p>`+
    `<button type="button" data-action="enable">Enable local measurement</button>`+
    `<button type="button" data-action="disable">Turn off</button>`+
    `<p role="status" aria-live="polite">${esc(view.label)}</p></section>`;
}

/** The host supplies the trusted route probe; UI never reads a user-supplied route claim. */
export function bindContributionSetup(root,{requestMic,verifiedRoute,subscribeRouteChange}){
  const enable=root?.querySelector?.('[data-action="enable"]');
  const disable=root?.querySelector?.('[data-action="disable"]');
  const status=root?.querySelector?.('[role="status"]');
  if(!enable||!disable||!status)throw new Error('Contribution controls required');
  const setup=new ContributionSetup({requestMic,verifiedRoute,onChange:view=>{
    status.textContent=view.label;
    enable.disabled=view.state==='REQUESTING'||view.state==='READY';
    disable.disabled=view.state==='OFF';
  }});
  const onEnable=()=>{setup.enable().catch(()=>setup.interrupt());};
  const onDisable=()=>setup.disable();
  if(typeof subscribeRouteChange!=='function')
    throw new Error('Route subscription required');
  const unsubscribe=subscribeRouteChange(()=>{setup.refreshRoute().catch(()=>setup.interrupt());});
  if(typeof unsubscribe!=='function')throw new Error('Route unsubscribe required');
  enable.addEventListener('click',onEnable);disable.addEventListener('click',onDisable);
  return ()=>{
    enable.removeEventListener('click',onEnable);disable.removeEventListener('click',onDisable);
    unsubscribe();
    setup.disable();
  };
}
