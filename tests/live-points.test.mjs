import test from 'node:test';import assert from 'node:assert/strict';
import {LivePointsView,renderLivePoints} from '../src/live-points.mjs';
const event=(overrides={})=>({artistId:'a1',occurrenceId:'o1',sequence:1,phase:'ITEM_ACTIVE',
  provisional:'10',spendable:'100',speakerVerified:true,outroComplete:false,interrupted:false,...overrides});
test('points remain provisional until issuer reports completed outro',()=>{
  const model=new LivePointsView();
  model.ingestTrusted(event());
  const closing=model.ingestTrusted(event({sequence:2,phase:'OUTRO_ACTIVE',provisional:'20'}));
  assert.match(renderLivePoints(closing),/not yet spendable/);
  const vested=model.ingestTrusted(event({sequence:3,phase:'VESTED',provisional:'0',spendable:'120',outroComplete:true}));
  assert.match(renderLivePoints(vested),/points vested/);
  assert.equal(vested.spendable,'120');
  assert.throws(()=>model.ingestTrusted(event({occurrenceId:'o2',sequence:4,
    phase:'VESTED',outroComplete:true,provisional:'1'})));
});
test('interruption forfeits provisional points and replay cannot restore them',()=>{
  const model=new LivePointsView();model.ingestTrusted(event());
  model.ingestTrusted(event({sequence:2,phase:'FORFEITED',provisional:'0',interrupted:true}));
  assert.throws(()=>model.ingestTrusted(event({sequence:3,phase:'VESTED',outroComplete:true})));
  assert.throws(()=>model.ingestTrusted(event()));
});
test('artist wallets are distinct and unverified/headphone provisional credit is rejected',()=>{
  const model=new LivePointsView();model.ingestTrusted(event());
  assert.equal(model.view('a2').spendable,'0');
  assert.throws(()=>model.ingestTrusted(event({artistId:'a2',speakerVerified:false})));
  assert.equal(model.view('a1').spendable,'100');
  assert.throws(()=>{model.view('a1').spendable='999999';},TypeError);
  assert.equal(model.view('a1').spendable,'100');
});
test('renderer escapes creator ID and avoids client-side grant claims',()=>{
  const model=new LivePointsView();
  const html=renderLivePoints(model.view('a1'));
  assert.match(html,/No verified point event/);assert.match(html,/Only the issuer can grant or spend/);
  assert.throws(()=>renderLivePoints({...model.view('a1'),spendable:'100'}));
  assert.throws(()=>renderLivePoints({...model.view('a1'),phase:'VESTED'}));
});
