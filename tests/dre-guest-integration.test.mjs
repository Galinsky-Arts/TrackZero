import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createDreGuestAdapter,GuestPlayer} from '../src/guest-radio.mjs';

const modulePath=process.env.DRE_PLAYBACK_MODULE;
test('actual DRE SDK maps first-frame readiness and later source loss into guest UI',
 {skip:!modulePath&&'Set DRE_PLAYBACK_MODULE to the pinned DRE playback source'},async()=>{
  const {createWebRadioPlayback}=await import(pathToFileURL(modulePath));
  let finish,closed=0,stopped=0;
  const end=new Promise(resolve=>{finish=resolve;});
  const states=[];
  const adapter=createDreGuestAdapter({createPlayback:createWebRadioPlayback,
   optionsForStation:async()=>({
    station:{read:async()=>({startedAtMs:1000,program:{stationId:'s1',version:1,digest:'digest',durationMs:3000,
     timeline:[{ref:'intro',role:'opening',fromMs:0,toMs:500},{ref:'song',role:'content',fromMs:500,toMs:2500},
      {ref:'outro',role:'closing',fromMs:2500,toMs:3000}]}}),verify:async()=>true},
    now:()=>2000,operationTimeoutMs:500,
    transport:{connect:async()=>({frames:(async function*(){yield {ciphertext:new Uint8Array([1])};await end;})(),
     close:async()=>{closed++;finish();}})},
    endpoint:{writeCiphertext:async()=>{},stop:async()=>{stopped++;}}
   })});
  const player=new GuestPlayer(adapter,state=>states.push(state));
  await player.play('s1');assert.equal(player.state,'PLAYING');
  finish();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(player.state,'INTERRUPTED');
  assert.equal(closed,1);assert.equal(stopped,1);
  assert.ok(states.indexOf('PLAYING')<states.indexOf('INTERRUPTED'));
  await player.stop();
 });

test('new guest playback waits for previous close and refuses failed cleanup',async()=>{
 let release,joins=0;
 const closing=new Promise(resolve=>{release=resolve;});
 const player=new GuestPlayer({joinLive:async()=>{joins++;return {start:async()=>{},close:()=>closing};}},()=>{});
 await player.play('s1');const next=player.play('s1');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(joins,1);
 release();await next;assert.equal(joins,2);await player.stop();
});
