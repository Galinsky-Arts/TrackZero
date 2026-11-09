import test from 'node:test';import assert from 'node:assert/strict';
import {ContributionSetup,renderContributionSetup,bindContributionSetup} from '../src/contribute-sound.mjs';
const stream=()=>{const tracks=[{stops:0,stop(){this.stops++},addEventListener(){}}];return {getTracks:()=>tracks,tracks};};
test('measurement requires explicit opt-in and verified active speaker route',async()=>{
  let requests=0;const views=[],mic=stream();
  const setup=new ContributionSetup({requestMic:async()=>{requests++;return mic},
    verifiedRoute:async()=>({verified:true,active:true,output:'bluetooth_speaker'}),onChange:view=>views.push(view)});
  assert.equal(requests,0);await setup.enable();assert.equal(requests,1);
  assert.equal(setup.state,'READY');assert.equal(views.at(-1).pointsEligible,false);
  setup.disable();assert.equal(mic.tracks[0].stops,1);assert.equal(setup.state,'OFF');
});
test('headphones and self-declared or inactive speakers stop microphone and grant no eligibility',async()=>{
  for(const route of [{verified:true,active:true,output:'headphones'},
    {verified:false,active:true,output:'bluetooth_speaker'},
    {verified:true,active:false,output:'bluetooth_speaker'}]){
    const mic=stream(),views=[];
    const setup=new ContributionSetup({requestMic:async()=>mic,verifiedRoute:async()=>route,onChange:v=>views.push(v)});
    await setup.enable();assert.equal(setup.state,'UNSUPPORTED');
    assert.equal(mic.tracks[0].stops,1);assert.equal(views.at(-1).pointsEligible,false);
  }
});
test('permission denial and route outage leave measurement off',async()=>{
  const denied=new ContributionSetup({requestMic:async()=>{const e=Error();e.name='NotAllowedError';throw e},
    verifiedRoute:async()=>({}),onChange:()=>{}});
  await denied.enable();assert.equal(denied.state,'DENIED');
  const mic=stream();const outage=new ContributionSetup({requestMic:async()=>mic,
    verifiedRoute:async()=>{throw Error('offline')},onChange:()=>{}});
  await outage.enable();assert.equal(outage.state,'INTERRUPTED');assert.equal(mic.tracks[0].stops,1);
});
test('disabling before asynchronous permission result stops late capture',async()=>{
  let resolve;const mic=stream();
  const setup=new ContributionSetup({requestMic:()=>new Promise(r=>resolve=r),
    verifiedRoute:async()=>({verified:true,active:true,output:'bluetooth_speaker'}),onChange:()=>{}});
  const pending=setup.enable();setup.disable();resolve(mic);await pending;
  assert.equal(setup.state,'OFF');assert.equal(mic.tracks[0].stops,1);
});
test('trusted route loss after readiness stops capture and cannot be restored by a late probe',async()=>{
  const mic=stream();let route={verified:true,active:true,output:'bluetooth_speaker'};
  const setup=new ContributionSetup({requestMic:async()=>mic,
    verifiedRoute:async()=>route,onChange:()=>{}});
  await setup.enable();assert.equal(setup.state,'READY');
  route={verified:true,active:true,output:'headphones'};
  await setup.refreshRoute();assert.equal(setup.state,'INTERRUPTED');
  assert.equal(mic.tracks[0].stops,1);
  await setup.refreshRoute();assert.equal(setup.state,'INTERRUPTED');
});
test('disabling during a pending route probe keeps measurement off',async()=>{
  const mic=stream();let probe=0,resolve;
  const setup=new ContributionSetup({requestMic:async()=>mic,verifiedRoute:()=>{
    probe++;return probe===1?Promise.resolve({verified:true,active:true,output:'bluetooth_speaker'}):
      new Promise(r=>resolve=r);
  },onChange:()=>{}});
  await setup.enable();const pending=setup.refreshRoute();setup.disable();
  resolve({verified:false,active:false,output:'headphones'});await pending;
  assert.equal(setup.state,'OFF');assert.equal(mic.tracks[0].stops,1);
});
test('safe disclosure does not invent points from consent',()=>{
  const view={state:'READY',label:'Local measurement is on; contribution still requires verified output evidence',pointsEligible:false};
  const html=renderContributionSetup(view);
  assert.match(html,/Microphone access is optional/);assert.match(html,/Headphones, mute/);
  assert.doesNotMatch(html,/you earned|pointsEligible=true/);
  assert.throws(()=>renderContributionSetup({...view,pointsEligible:true}));
});
test('UI controls bind opt-in and stop capture on disposal',async()=>{
  const element=()=>({disabled:false,textContent:'',handlers:new Map(),
    addEventListener(type,fn){this.handlers.set(type,fn)},removeEventListener(type){this.handlers.delete(type)},
    click(){this.handlers.get('click')?.()}});
  const enable=element(),disable=element(),status=element(),mic=stream();
  const root={querySelector:s=>s.includes('enable')?enable:s.includes('disable')?disable:status};
  assert.throws(()=>bindContributionSetup(root,{requestMic:async()=>mic,
    verifiedRoute:async()=>({verified:true,active:true,output:'bluetooth_speaker'})}),/Route subscription required/);
  let route={verified:true,active:true,output:'bluetooth_speaker'},routeChanged,unsubscribed=0;
  const dispose=bindContributionSetup(root,{requestMic:async()=>mic,
    verifiedRoute:async()=>route,subscribeRouteChange:callback=>{routeChanged=callback;return ()=>unsubscribed++;}});
  assert.equal(status.textContent,'Off');enable.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(status.textContent,/Local measurement is on/);
  route={verified:true,active:true,output:'headphones'};routeChanged();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(status.textContent,'Measurement interrupted');
  dispose();assert.equal(mic.tracks[0].stops,1);assert.equal(enable.handlers.size,0);
  assert.equal(unsubscribed,1);
});

test('a retired capture cannot interrupt a later explicit capture',async()=>{
 const captures=[];
 const setup=new ContributionSetup({requestMic:async()=>{
  let ended;const track={stop(){},addEventListener(_type,callback){ended=callback;}};
  const capture={getTracks:()=>[track],end:()=>ended?.()};captures.push(capture);return capture;
 },verifiedRoute:async()=>({verified:true,active:true,output:'wired_speaker'}),onChange:()=>{}});
 await setup.enable();setup.disable();await setup.enable();
 assert.equal(setup.state,'READY');captures[0].end();assert.equal(setup.state,'READY');
 captures[1].end();assert.equal(setup.state,'INTERRUPTED');
});
