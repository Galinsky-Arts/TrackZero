import assert from 'node:assert/strict';
import test from 'node:test';
import {matchStationOffers} from '../src/station-offers.mjs';

const station={id:'station-one',name:'Station One',description:'Radio',
  offers:[{id:'album-001',title:'Album One',type:'complete_product',available:true}]};
const catalog=[{id:'album-001',title:'Album One',kind:'album',trackCount:9}];

test('station offers require an independently authorized complete album',async()=>{
  assert.deepEqual(await matchStationOffers(station,catalog,async()=>true),[
    {id:'album-001',title:'Album One',trackCount:9,type:'complete_product',stationId:'station-one'}
  ]);
});
test('offers fail closed on missing catalog, denied rights or malformed station data',async()=>{
  await assert.rejects(matchStationOffers(station,[],async()=>true),/not present/);
  await assert.rejects(matchStationOffers(station,catalog,async()=>false),/not verified/);
  await assert.rejects(matchStationOffers(station,catalog),/verifier required/);
  await assert.rejects(matchStationOffers({...station,id:'?'},catalog,async()=>true),/Invalid station/);
  await assert.rejects(matchStationOffers({...station,offers:[{...station.offers[0],type:'track'}]},catalog,async()=>true),/Invalid complete-product offer/);
  await assert.rejects(matchStationOffers({...station,offers:[station.offers[0],station.offers[0]]},catalog,async()=>true),/Duplicate station offer/);
});
