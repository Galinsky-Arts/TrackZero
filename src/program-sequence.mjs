export function validateProgram(items){
 if(!Array.isArray(items)||items.length<1||items.length>1000||!items.every(x=>x&&typeof x.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x.id)&&['song','ad','intro','block'].includes(x.kind)))throw new Error('Invalid program');
 const ids=items.map(x=>x.id);if(new Set(ids).size!==ids.length)throw new Error('Duplicate item id');
 return items.map(item=>Object.freeze({id:item.id,kind:item.kind}));
}
export function reorderProgram(items, from, to){
 const result=validateProgram(items);
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=items.length||to>=items.length)throw new Error('Invalid index');
 const [moved]=result.splice(from,1);result.splice(to,0,moved);return result;
}

function escapeHtml(value){return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}

export function renderProgramEditor(items,{editable=true,announcement='',canUndo=false}={}){
  const sequence=validateProgram(items);
  const rows=sequence.map((item,index)=>{
    const label=escapeHtml(item.kind+' '+item.id),id=escapeHtml(item.id);
    return `<li draggable="${editable}" data-id="${id}"><span>${label}</span>`+
      `<button type="button" data-action="up" data-id="${id}" aria-label="Move ${label} up" ${!editable||index===0?'disabled':''}>Move up</button>`+
      `<button type="button" data-action="down" data-id="${id}" aria-label="Move ${label} down" ${!editable||index===sequence.length-1?'disabled':''}>Move down</button></li>`;
  }).join('');
  return `<section aria-labelledby="program-title"><h2 id="program-title">Program sequence</h2>`+
    `<p>Use Move up or Move down with a keyboard; pointer users may drag a row.</p>`+
    `<ol>${rows}</ol><p role="status" aria-live="polite">${escapeHtml(announcement)}</p>`+
    `<button type="button" data-action="undo" ${editable&&canUndo?'':'disabled'}>Undo</button>`+
    `<button type="button" data-action="save" ${editable?'':'disabled'}>Save sequence</button></section>`;
}

/** UI state is not broadcast authorization. save must call a fenced backend
 * that checks broadcaster membership, rights and expected schedule version. */
export function createProgramController(items,{save,version,editable=true}){
  if(typeof save!=='function'||!Number.isSafeInteger(version)||version<0)throw new Error('Save adapter and schedule version required');
  let current=validateProgram(items),history=[],announcement='',saving=false;
  const snapshot=()=>({items:[...current],version,announcement,canUndo:history.length>0,editable,saving});
  function move(id,target){
    if(!editable||saving)throw new Error('Program editing unavailable');
    const from=current.findIndex(item=>item.id===id),to=current.findIndex(item=>item.id===target);
    if(from<0||to<0)throw new Error('Unknown program item');
    if(from===to)return snapshot();
    history.push(current);current=reorderProgram(current,from,to);
    announcement=`Moved ${current[to].kind} ${current[to].id} to position ${to+1} of ${current.length}.`;
    return snapshot();
  }
  return {
    snapshot,
    drag:move,
    moveBy(id,direction){
      const from=current.findIndex(item=>item.id===id),to=from+direction;
      if(from<0||![-1,1].includes(direction)||to<0||to>=current.length)throw new Error('Invalid move');
      return move(id,current[to].id);
    },
    undo(){
      if(!editable||saving||!history.length)throw new Error('Undo unavailable');
      current=history.pop();announcement='Last move undone.';return snapshot();
    },
    async save(){
      if(!editable||saving)throw new Error('Program editing unavailable');
      saving=true;announcement='Saving sequence.';
      try{
        const result=await save({items:[...current],expectedVersion:version});
        if(!result||!Number.isSafeInteger(result.version)||result.version<=version)
          throw new Error('Save did not confirm a new schedule version');
        version=result.version;history=[];announcement='Sequence saved.';
      }catch(error){announcement='Save failed; sequence remains unsaved.';throw error;}
      finally{saving=false;}
      return snapshot();
    }
  };
}

/** Browser adapter: keyboard buttons and pointer drag/drop share the same
 * ID-stable controller. Consumers must pass a trusted backend save function. */
export function mountProgramEditor(container,controller){
  if(!container||typeof container.addEventListener!=='function'||!controller||typeof controller.snapshot!=='function')
    throw new Error('Editor container and controller required');
  const render=()=>{const state=controller.snapshot();container.innerHTML=renderProgramEditor(state.items,{editable:state.editable&&!state.saving,announcement:state.announcement,canUndo:state.canUndo});};
  let dragging=null;
  container.addEventListener('click',async event=>{
    const button=event.target.closest?.('button[data-action]');if(!button||!container.contains(button))return;
    try{
      if(button.dataset.action==='up')controller.moveBy(button.dataset.id,-1);
      else if(button.dataset.action==='down')controller.moveBy(button.dataset.id,1);
      else if(button.dataset.action==='undo')controller.undo();
      else if(button.dataset.action==='save')await controller.save();
    }catch{/* Controller announces save failures; invalid UI moves are inert. */}
    render();
  });
  container.addEventListener('dragstart',event=>{dragging=event.target.closest?.('li[data-id]')?.dataset.id??null;});
  container.addEventListener('dragover',event=>{if(dragging)event.preventDefault();});
  container.addEventListener('drop',event=>{
    event.preventDefault();const target=event.target.closest?.('li[data-id]')?.dataset.id;
    try{if(dragging&&target)controller.drag(dragging,target);}catch{}dragging=null;render();
  });
  container.addEventListener('dragend',()=>{dragging=null;});
  render();return {render};
}
