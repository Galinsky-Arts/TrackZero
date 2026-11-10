import {createPrivateBoundary} from './private-endpoint.mjs';
import {BoundaryError} from './http-boundary.mjs';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class GrooveSettingsError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function creator(value){
 if(!value||value.role!=='creator'||![value.tenantId,value.applicationId,value.principalId].every(validId))throw new GrooveSettingsError('CREATOR_REQUIRED',403);
 return Object.freeze({tenantId:value.tenantId,applicationId:value.applicationId,principalId:value.principalId});
}
function fields(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.sort().join(',');}
/** Music-facing proposal builder. DRE owns rarity/cadence and atomic publication. */
export function createGrooveSettings({eligibleRarityWeights,transitionOpportunity,recordingRegistry,authorizeCreator,
 verifyRecording,publishConfiguration}={}){
 if(![eligibleRarityWeights,transitionOpportunity,authorizeCreator,verifyRecording,publishConfiguration].every(fn=>typeof fn==='function')||typeof recordingRegistry?.get!=='function')throw Error('Actual DRE rules, channel registry and approved endpoint publisher required');
 async function preview(identity,input){
  const scope=creator(identity);
  if(!fields(input,['stationId','version','everyMin','everyMax','rarityBase','recordings'])||!validId(input.stationId)||
   !Number.isSafeInteger(input.version)||input.version<1||!Number.isSafeInteger(input.everyMin)||!Number.isSafeInteger(input.everyMax)||
   !Number.isSafeInteger(input.rarityBase)||input.rarityBase<2||input.rarityBase>100||!Array.isArray(input.recordings)||input.recordings.length<1||input.recordings.length>32)
   throw new GrooveSettingsError('INVALID_SETTINGS');
  const candidate=structuredClone(input);
  if(await authorizeCreator(scope,{stationId:candidate.stationId,action:'configure-grooves'})!==true)throw new GrooveSettingsError('CREATOR_DENIED',403);
  const seen=new Set(),grooves=new Set();
  for(const item of candidate.recordings){
   if(!fields(item,['grooveId','recordingId','minimumCompletions','stock','exclusive','channel'])||![item.grooveId,item.recordingId].every(validId)||seen.has(item.recordingId)||grooves.has(item.grooveId)||
    item.channel!=='groove'||item.exclusive!==true||!Number.isSafeInteger(item.stock)||item.stock<0||item.stock>1000000||!Number.isSafeInteger(item.minimumCompletions)||item.minimumCompletions<0)
    throw new GrooveSettingsError('SEPARATE_BONUS_CATALOG_REQUIRED');
   seen.add(item.recordingId);grooves.add(item.grooveId);
   const reservation=recordingRegistry.get({...scope,recordingId:item.recordingId});
   if(reservation&&(reservation.channel!=='groove'||reservation.creatorId!==scope.principalId||reservation.entryId!==item.grooveId))throw new GrooveSettingsError('RECORDING_CHANNEL_CONFLICT',409);
   if(await verifyRecording(scope,Object.freeze({...item,stationId:candidate.stationId}))!==true)throw new GrooveSettingsError('RECORDING_NOT_AUTHORIZED',403);
  }
  let weights;try{
   weights=eligibleRarityWeights({minimumCompletions:candidate.recordings.map(x=>x.minimumCompletions),completed:Number.MAX_SAFE_INTEGER,base:BigInt(candidate.rarityBase)});
   transitionOpportunity({stationId:candidate.stationId,programVersion:candidate.version,completedItems:0,everyMin:candidate.everyMin,everyMax:candidate.everyMax,sequence:0});
  }catch{throw new GrooveSettingsError('INVALID_ELIGIBILITY_OR_CADENCE');}
  return Object.freeze({...candidate,creatorId:scope.principalId,tiers:candidate.recordings.map((item,i)=>({...item,weight:weights.weights[i].toString()})),
   disclosure:`Opportunities follow every ${candidate.everyMin}–${candidate.everyMax} completed songs at the shared outro-to-intro transition. Headphones and speakers qualify. Completed-listen thresholds and stock apply; a rare recording is never guaranteed. These bonus recordings are separate from paid albums and point rewards.`});
 }
 async function publish(identity,input,{operationId,proof}={}){
  const scope=creator(identity);if(!validId(operationId)||operationId.length<20||typeof proof!=='string'||!proof||proof.length>8192)throw new GrooveSettingsError('TRANSACTION_APPROVAL_REQUIRED',403);
  const approved=await preview(identity,input);
  // The approved endpoint must atomically recheck rights/channel/version and persist
  // catalog, stock and policy under this operation ID. No piecemeal client writes.
  const receipt=await publishConfiguration(scope,structuredClone(approved),{operationId,proof,expectedPreviousVersion:input.version-1});
  if(!receipt||receipt.tenantId!==scope.tenantId||receipt.applicationId!==scope.applicationId||receipt.creatorId!==scope.principalId||
   receipt.stationId!==input.stationId||receipt.version!==input.version||receipt.operationId!==operationId||receipt.committed!==true)throw new GrooveSettingsError('PUBLICATION_NOT_COMMITTED',503);
  return {stationId:input.stationId,version:input.version,committed:true};
 }
 return Object.freeze({preview,publish});
}
export function renderGrooveSettings(preview){
 if(!preview||!Array.isArray(preview.tiers)||preview.tiers.length>32||typeof preview.disclosure!=='string')throw new GrooveSettingsError('INVALID_PREVIEW');
 return `<section aria-labelledby="groove-settings-title"><h2 id="groove-settings-title">Unlocked Groove settings</h2><p>${esc(preview.disclosure)}</p>`+
 `<table><caption>Separate bonus catalog preview</caption><thead><tr><th scope="col">Recording</th><th scope="col">Completed listens</th><th scope="col">Relative rarity weight</th><th scope="col">Stock</th></tr></thead><tbody>`+
 preview.tiers.map(x=>`<tr><th scope="row">${esc(x.recordingId)}</th><td>${esc(x.minimumCompletions)}</td><td>${esc(x.weight)}</td><td>${esc(x.stock)}</td></tr>`).join('')+'</tbody></table></section>';
}
export function createGrooveSettingsHandler({settings,authenticate,decodeControl,encodeResponse}={}){
 if(!settings||typeof settings.preview!=='function'||typeof settings.publish!=='function'||typeof authenticate!=='function')throw Error('Approved settings and creator identity required');
 const boundary=createPrivateBoundary({decodeControl,encodeResponse});
 return async request=>{
  const url=new URL(request.url);const failure=(status,code)=>new Response(JSON.stringify({error:code}),{status,headers:{'cache-control':'no-store','content-type':'application/json'}});
  try{
   if(request.method!=='POST'||!['/v1/grooves/preview','/v1/grooves/publish'].includes(url.pathname))return failure(404,'NOT_FOUND');
   if(request.headers.get('origin')!==url.origin)throw new GrooveSettingsError('ORIGIN_DENIED',403);
   const identity=await authenticate(request);creator(identity);
   const operationId=request.headers.get('idempotency-key'),context={action:'groove-settings',path:url.pathname,operationId};
   const body=await boundary.read(request,identity,context);
   let result;
   if(url.pathname.endsWith('/preview'))result={preview:await settings.preview(identity,body)};
   else {if(!fields(body,['settings','proof']))throw new GrooveSettingsError('INVALID_SETTINGS');result=await settings.publish(identity,body.settings,{operationId,proof:body.proof});}
   return await boundary.respond(200,identity,result,context);
  }catch(error){return error instanceof GrooveSettingsError||error instanceof BoundaryError?failure(error.status,error.code):failure(503,'GROOVE_SETTINGS_UNAVAILABLE');}
 };
}

/** Exact DRE transaction bridge. The authorizer rechecks current creator/rights authority. */
export function createDreGrooveConfigurationPublisher({registry,authorizeConfiguration}={}){
 if(typeof registry?.publishGrooveConfiguration!=='function'||typeof authorizeConfiguration!=='function')throw Error('Actual atomic DRE configuration publisher and authorizer required');
 return (scope,preview,{operationId,proof,expectedPreviousVersion})=>registry.publishGrooveConfiguration({
  tenantId:scope.tenantId,applicationId:scope.applicationId,creatorId:scope.principalId,stationId:preview.stationId,
  operationId,expectedPreviousVersion,version:preview.version,everyMin:preview.everyMin,everyMax:preview.everyMax,
  rarityBase:preview.rarityBase,recordings:preview.recordings},command=>authorizeConfiguration(scope,command,proof));
}
