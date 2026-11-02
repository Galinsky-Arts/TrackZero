import assert from 'node:assert/strict';import test from 'node:test';import {validateStationStorefront,renderStorefrontHtml} from '../src/storefront.mjs';
const valid={id:'station-01',name:'Station One',description:'Broadcaster details',offers:[{id:'album-001',title:'Full album',type:'complete_product',available:true}]};
test('renders validated station metadata and complete-product offers',()=>{const station=validateStationStorefront(valid);assert.equal(station.offers[0].type,'complete_product');assert.equal(station.name,'Station One');});
test('rejects unknown, inactive and individual-track purchases',()=>{for(const x of [{...valid,id:'?'},{...valid,artworkUrl:'javascript:alert(1)'},{...valid,offers:[{...valid.offers[0],type:'track'}]},{...valid,offers:[{...valid.offers[0],available:false}]}])assert.throws(()=>validateStationStorefront(x));});
test('renders an accessible inert catalog without untrusted controls',()=>{
 const html=renderStorefrontHtml(valid);
 assert.match(html,/<main>/);assert.match(html,/<h1 id="station-title">Station One<\/h1>/);
 assert.match(html,/<ul>/);assert.doesNotMatch(html,/<(?:button|form|audio)\b|purchase|play now/i);
 assert.match(renderStorefrontHtml({...valid,offers:[]}),/No catalog information is available/);
});
test('escapes attacker-controlled station and offer text',()=>{
 const html=renderStorefrontHtml({...valid,name:'<img src=x onerror=alert(1)>',description:'<script>alert(1)</script>',
  offers:[{...valid.offers[0],title:'<svg onload=alert(1)>'}]});
 assert.doesNotMatch(html,/<script|<svg|<img src=x/i);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;svg/);
});
test('artwork must come from an explicitly trusted HTTPS origin',()=>{
 const artworkOrigins=['https://assets.example.test'];
 const record={...valid,artworkUrl:'https://assets.example.test/station.png'};
 assert.match(renderStorefrontHtml(record,{artworkOrigins}),/<img src="https:\/\/assets.example.test\/station.png"/);
 for(const artworkUrl of [
  'https://evil.example.test/station.png','https://assets.example.test.evil.test/a.png',
  'https://user:pass@assets.example.test/a.png','http://assets.example.test/a.png',
  'https://assets.example.test:8443/a.png','https://assets.example.test/a.png#frag'
 ])assert.throws(()=>renderStorefrontHtml({...record,artworkUrl},{artworkOrigins}),/artwork/i);
 assert.throws(()=>renderStorefrontHtml(record),/artwork/i);
});
