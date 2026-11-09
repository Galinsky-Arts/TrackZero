import test from 'node:test';import assert from 'node:assert/strict';
import {createRewardPricing,rewardPreview,renderRewardPreview} from '../src/reward-prices.mjs';
const modulePath=process.env.DRE_PLAYBACK_MODULE;
if(!modulePath)throw Error('Pinned DRE_PLAYBACK_MODULE required for price integration');
const {pathToFileURL}=await import('node:url');
const sdk=await import(new URL('./reward-ladder.mjs',pathToFileURL(modulePath)));
const quote=createRewardPricing(sdk);
const defaultRewardPrice=config=>{const result=quote({artistId:'artist-a',...config});assert.equal(result.kind,'quoted');return result.points;};
test('base tier and linear factor use exact integer ceilings',()=>{
  assert.equal(defaultRewardPrice({base:'101',gentleBps:100,accelerationBps:0,tier:0}),101n);
  assert.equal(defaultRewardPrice({base:'101',gentleBps:100,accelerationBps:0,tier:1}),103n);
});
test('bounded exponential ladder grows and handles large integers',()=>{
  const config={base:'1000000000000',gentleBps:20,accelerationBps:20};
  const prices=[0,10,50,100].map(tier=>defaultRewardPrice({...config,tier}));
  assert.ok(prices.every((p,i)=>i===0||p>prices[i-1]));
  assert.ok(prices.at(-1)>BigInt(Number.MAX_SAFE_INTEGER));
});
test('default curve begins slowly and grows sharply while preview uses exact spendable balance',()=>{
  const config={base:'100',gentleBps:20,accelerationBps:2};
  const [start,early,middle,late]=[0,10,50,100].map(tier=>defaultRewardPrice({...config,tier}));
  assert.ok(early-start<middle-early);
  assert.ok(middle-early<late-middle);
  const offer={id:'rare-take',artistId:'artist-a',title:'Rare take',version:1,
    cost:late.toString(),available:true};
  const short=rewardPreview(offer,{artistId:'artist-a',spendable:(late-1n).toString()});
  assert.equal(short.canRequest,false);
  assert.match(renderRewardPreview(short),new RegExp(`cost ${late} artist points`));
  assert.equal(rewardPreview(offer,{artistId:'artist-a',spendable:late.toString()}).canRequest,true);
});
test('rejects malformed settings while large tiers remain symbolic without a business cap',()=>{
  assert.throws(()=>defaultRewardPrice({base:'1e3',gentleBps:0,accelerationBps:0,tier:0}));
  const huge=quote({artistId:'artist-a',base:'1',tier:'999999999999999999999999999999999999'});
  assert.equal(huge.kind,'symbolic');assert.equal(huge.points,null);assert.equal(huge.spendAuthorized,false);
  assert.throws(()=>defaultRewardPrice({base:'0',gentleBps:0,accelerationBps:0,tier:0}));
});
test('artist-specific snapshot never treats display as redemption',()=>{
  const offer={id:'r1',artistId:'a1',title:'Rare <Take>',version:7,cost:'999999999999999999',available:true};
  const view=rewardPreview(offer,{artistId:'a1',spendable:'1000000000000000000'});
  assert.equal(view.canRequest,true);
  const html=renderRewardPreview(view);assert.match(html,/Rare &lt;Take&gt;/);
  assert.match(html,/must recheck the offer and spend atomically/);
  assert.throws(()=>rewardPreview(offer,{artistId:'a2',spendable:'999999999999999999'}));
  assert.equal(rewardPreview({...offer,available:false},{artistId:'a1',spendable:view.balance}).canRequest,false);
  for(const forged of [{available:'false'}, {available:1}, {balance:'-1'},
    {cost:'0'}, {canRequest:'true'}, {title:''}, {canRequest:false},
    {id:{toString:()=>offer.id}}])
    assert.throws(()=>renderRewardPreview({...view,...forged}));
});
