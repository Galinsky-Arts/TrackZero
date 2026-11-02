import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProgram,reorderProgram,renderProgramEditor,createProgramController} from '../src/program-sequence.mjs';
const input=[{id:'a',kind:'intro'},{id:'b',kind:'song'},{id:'c',kind:'ad'}];
test('reorders without modifying source',()=>{assert.deepEqual(reorderProgram(input,0,2).map(x=>x.id),['b','c','a']);assert.equal(input[0].id,'a')});
test('invalid indexes, empty programs and duplicate blocks are denied',()=>{
 assert.throws(()=>reorderProgram(input,-1,2));
 assert.throws(()=>reorderProgram([input[0],input[0]],0,1));
 assert.throws(()=>validateProgram([]));
 assert.deepEqual(validateProgram([{id:'safe',kind:'song',untrusted:{url:'https://example.test'}}]),[{id:'safe',kind:'song'}]);
});
test('keyboard moves and drag share ID-stable order, announcements and undo',()=>{
 const editor=createProgramController(input,{save:async()=>({version:2}),version:1});
 assert.deepEqual(editor.moveBy('a',1).items.map(x=>x.id),['b','a','c']);
 assert.match(editor.snapshot().announcement,/position 2 of 3/);
 assert.deepEqual(editor.drag('a','c').items.map(x=>x.id),['b','c','a']);
 assert.deepEqual(editor.undo().items.map(x=>x.id),['b','a','c']);
 assert.deepEqual(editor.undo().items.map(x=>x.id),['a','b','c']);
 assert.throws(()=>editor.moveBy('a',-1),/Invalid move/);
});
test('save requires a confirmed new version and exposes failures without losing edits',async()=>{
 let calls=0;
 const editor=createProgramController(input,{version:3,save:async({items,expectedVersion})=>{
  calls++;assert.equal(expectedVersion,3);assert.deepEqual(items.map(x=>x.id),['b','a','c']);
  if(calls===1)throw new Error('offline');return {version:4};}});
 editor.moveBy('a',1);
 await assert.rejects(editor.save(),/offline/);
 assert.match(editor.snapshot().announcement,/Save failed/);
 assert.deepEqual(editor.snapshot().items.map(x=>x.id),['b','a','c']);
 const saved=await editor.save();
 assert.equal(saved.version,4);assert.equal(saved.saving,false);
 assert.equal(editor.snapshot().canUndo,false);
});
test('rendered editor escapes identifiers and has keyboard equivalents and live status',()=>{
 const html=renderProgramEditor([{id:'a',kind:'song'}],{announcement:'Saved <unsafe>'});
 assert.match(html,/Move up/);assert.match(html,/Move down/);
 assert.match(html,/aria-live="polite"/);assert.match(html,/Saved &lt;unsafe&gt;/);
 assert.doesNotMatch(html,/Saved <unsafe>/);
 assert.throws(()=>renderProgramEditor([{id:'a&b',kind:'song'}]));
 assert.throws(()=>renderProgramEditor([]));
 assert.match(renderProgramEditor(input,{canUndo:false}),/data-action="undo" disabled/);
});
test('read-only editor blocks editing and disables controls',()=>{
 const editor=createProgramController(input,{save:async()=>({version:2}),version:1,editable:false});
 assert.throws(()=>editor.drag('a','b'),/unavailable/);
 assert.match(renderProgramEditor(input,{editable:false}),/disabled/);
});
