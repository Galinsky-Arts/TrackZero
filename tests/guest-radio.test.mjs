import test from 'node:test';import assert from 'node:assert/strict';
import {renderStationPage,renderAlbumPage,GuestPlayer,bindGuestControls,createGuestHandler} from '../src/guest-radio.mjs';
const station={id:'s1',name:'Radio <One>',description:'A live & linear station'};
const album={id:'a1',title:'First <Album>',artist:'A & B',artworkUrl:'https://art.example/a.jpg'};
const policy={artworkOrigins:['https://art.example']};
test('public pages escape metadata, link complete albums, and expose no picker or media secrets',()=>{
  const page=renderStationPage(station,[album],policy);
  assert.match(page,/Radio &lt;One&gt;/);assert.match(page,/First &lt;Album&gt;/);
  assert.match(page,/\/albums\/a1/);assert.match(page,/joins the current broadcast/);
  assert.doesNotMatch(page,/<audio|track-picker|playback-token|manifest/);
  assert.match(renderAlbumPage(album,policy),/Complete-album information/);
});
test('rejects hostile artwork, malformed ids and duplicate offers',()=>{
  assert.throws(()=>renderStationPage(station,[{...album,artworkUrl:'javascript:alert(1)'}],policy));
  assert.throws(()=>renderStationPage(station,[{...album,artworkUrl:'https://evil.example/a.jpg'}],policy));
  assert.throws(()=>renderStationPage(station,[album,album],policy));
  assert.throws(()=>renderAlbumPage(album));
  assert.throws(()=>createGuestHandler({getStation:async()=>station,getAlbums:async()=>[album],
    getAlbum:async()=>album,artworkOrigins:['https://art.example/extra']}));
  assert.throws(()=>renderStationPage({...station,id:'../other'},[]));
});
test('guest handler serves only exact public metadata and fails closed on provider outage',async()=>{
  const handler=createGuestHandler({getStation:async id=>id==='s1'?station:null,
    getAlbums:async()=>[album],getAlbum:async id=>id==='a1'?album:null,...policy});
  const response=await handler(new Request('https://example.test/stations/s1'));
  assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  assert.match(response.headers.get('content-security-policy'),/img-src https:\/\/art\.example;/);
  assert.doesNotMatch(response.headers.get('content-security-policy'),/img-src https:;/);
  assert.equal((await handler(new Request('https://example.test/stations/s2'))).status,404);
  assert.equal((await handler(new Request('https://example.test/albums/a1',{method:'POST'}))).status,405);
  const down=createGuestHandler({getStation:async()=>{throw Error('offline')},getAlbums:async()=>[],getAlbum:async()=>null,...policy});
  assert.equal((await down(new Request('https://example.test/stations/s1'))).status,503);
});
test('explicit play joins live once and stop closes endpoint session',async()=>{
  const states=[],calls=[];let closed=0;
  const player=new GuestPlayer({joinLive:async(id,{signal})=>{
    calls.push([id,signal]);return {start:async()=>{},close:()=>{++closed}};
  }},state=>states.push(state));
  await player.play('s1');assert.equal(player.state,'PLAYING');assert.equal(calls.length,1);
  player.stop();assert.equal(player.state,'STOPPED');assert.equal(closed,1);
  assert.deepEqual(states,['STOPPED','CONNECTING','PLAYING','STOPPED']);
});
test('stop during join prevents late playback and closes late session',async()=>{
  let resolve,starts=0,closed=0;
  const player=new GuestPlayer({joinLive:()=>new Promise(r=>resolve=r)},()=>{});
  const pending=player.play('s1');player.stop();
  resolve({start:async()=>{++starts},close:()=>{++closed}});await pending;
  assert.equal(starts,0);assert.equal(closed,1);assert.equal(player.state,'STOPPED');
});
test('adapter failure reports interruption without leaving a live session',async()=>{
  let closed=0;
  const player=new GuestPlayer({joinLive:async()=>({start:async()=>{throw Error('network')},close:()=>{++closed}})},()=>{});
  await assert.rejects(player.play('s1'));
  assert.equal(player.state,'INTERRUPTED');assert.equal(closed,1);
});
test('close failure cannot retain a session or leave controls falsely playing',async()=>{
  const player=new GuestPlayer({joinLive:async()=>({start:async()=>{},close:()=>{throw Error('close failed')}})},()=>{});
  await player.play('s1');player.stop();
  assert.equal(player.current,null);
  assert.equal(player.state,'INTERRUPTED');
  await assert.rejects(player.play('s1'),/PLAYBACK_CLEANUP_FAILED/);
  assert.equal(player.state,'INTERRUPTED');
});
test('asynchronous close failure reports interruption only for the stopped session',async()=>{
  const player=new GuestPlayer({joinLive:async()=>({start:async()=>{},close:()=>Promise.reject(Error('close failed'))})},()=>{});
  await player.play('s1');player.stop();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(player.state,'INTERRUPTED');
  assert.equal(player.current,null);
});
test('accessible controls bind explicit play and stop without route navigation',async()=>{
  const element=()=>({disabled:false,textContent:'',dataset:{station:'s1'},handlers:new Map(),
    addEventListener(type,fn){this.handlers.set(type,fn)},removeEventListener(type){this.handlers.delete(type)},
    click(){this.handlers.get('click')?.()}});
  const play=element(),stop=element(),status=element();
  const root={querySelector:selector=>selector.includes('play')?play:selector.includes('stop')?stop:status};
  let joined=0,closed=0;
  const dispose=bindGuestControls(root,{joinLive:async()=>{++joined;return {start:async()=>{},close:()=>{++closed}}}});
  assert.equal(status.textContent,'Stopped');play.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(joined,1);assert.equal(status.textContent,'Playing live radio');assert.equal(stop.disabled,false);
  stop.click();assert.equal(status.textContent,'Stopped');assert.equal(closed,1);
  dispose();assert.equal(play.handlers.size,0);
});
