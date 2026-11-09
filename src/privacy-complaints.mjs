import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,fstatSync,statSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {createPrivateBoundary} from './private-endpoint.mjs';
import {BoundaryError} from './http-boundary.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.sort().join(',');
export class PrivacyError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function principal(p){
 if(!p||![p.tenant,p.application,p.subject].every(valid))throw new PrivacyError('UNAUTHENTICATED',401);
 return Object.freeze({tenant:p.tenant,application:p.application,subject:p.subject});
}
function prose(value){return typeof value==='string'&&value===value.trim()&&value.length>=10&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)&&Buffer.byteLength(value)<=1000;}
function complaint(value){if(!exact(value,['target','reason'])||!valid(value.target)||!prose(value.reason))throw new PrivacyError('INVALID_COMPLAINT');return structuredClone(value);}
function decision(value){if(!exact(value,['outcome','explanation','operatorId'])||!['WARNING','RESTRICTION','RESTORED'].includes(value.outcome)||!prose(value.explanation)||!valid(value.operatorId))throw new PrivacyError('INVALID_DECISION');return structuredClone(value);}
function privateFile(filename){
 if(typeof filename!=='string'||!isAbsolute(filename))throw Error('Absolute private database path required');
 const parent=statSync(dirname(filename));if(!parent.isDirectory()||(parent.mode&0o077)!==0||parent.uid!==process.getuid())throw Error('Owner-private database directory required');
 const fd=openSync(filename,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{const file=fstatSync(fd);if(!file.isFile()||file.nlink!==1||file.uid!==process.getuid()||(file.mode&0o077)!==0)throw Error('Owner-private ordinary database required');}finally{closeSync(fd);}
}
/** Ciphertext store. Approved endpoint seal/open adapters own keys and authentication. */
export class PrivacyStore{
 #db;#seal;#open;#authorize;#now;
 constructor(filename,{seal,open,authorizeDecision,now=Date.now}={}){
  if(![seal,open,authorizeDecision,now].every(fn=>typeof fn==='function'))throw Error('Approved endpoint storage codecs and moderator authorization required');
  privateFile(filename);this.#seal=seal;this.#open=open;this.#authorize=authorizeDecision;this.#now=now;
  this.#db=new DatabaseSync(filename);
  try{
   if(this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('complaints','account_decisions')").get())throw Error('Legacy plaintext privacy store requires explicit endpoint migration');
   this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS privacy_preferences(tenant TEXT,application TEXT,subject TEXT,public_profile INTEGER NOT NULL CHECK(public_profile IN(0,1)),PRIMARY KEY(tenant,application,subject));
    CREATE TABLE IF NOT EXISTS private_cases(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('complaint','decision')),tenant TEXT NOT NULL,application TEXT NOT NULL,subject TEXT NOT NULL,created_at INTEGER NOT NULL,ciphertext BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS private_cases_scope ON private_cases(tenant,application,subject,kind);`);
  }catch(error){this.#db.close();throw error;}
 }
 close(){this.#db.close();}
 #time(){const n=this.#now();if(!Number.isSafeInteger(n)||n<0||n>8640000000000000)throw new PrivacyError('INVALID_CLOCK');return n;}
 #context(p,id,kind,createdAt){return Object.freeze({domain:'TrackZero-private-case-v1',...p,id,kind,createdAt});}
 async #decode(row){
  const context=this.#context(principal(row),row.id,row.kind,row.created_at);
  const value=await this.#open(new Uint8Array(row.ciphertext),context);
  return row.kind==='complaint'?complaint(value):decision(value);
 }
 async #save(p,id,kind,value,guard=null){
  const previous=this.#db.prepare('SELECT * FROM private_cases WHERE id=?').get(id);
  if(previous){if(['tenant','application','subject'].some(k=>previous[k]!==p[k])||previous.kind!==kind||JSON.stringify(await this.#decode(previous))!==JSON.stringify(value))throw new PrivacyError('OPERATION_CONFLICT',409);return {id,...value,createdAt:new Date(previous.created_at).toISOString()};}
  const createdAt=this.#time(),context=this.#context(p,id,kind,createdAt);
  const bytes=await this.#seal(structuredClone(value),context);
  if(!(bytes instanceof Uint8Array)||bytes.length<16||bytes.length>4096)throw new PrivacyError('INVALID_SEALED_RECORD');
  if(guard&&await guard()!==true)throw new PrivacyError('MODERATOR_DENIED',403);
  this.#db.exec('BEGIN IMMEDIATE');
  try{
   const raced=this.#db.prepare('SELECT * FROM private_cases WHERE id=?').get(id);
   if(raced){this.#db.exec('ROLLBACK');return this.#save(p,id,kind,value,guard);}
   const count=this.#db.prepare('SELECT COUNT(*) AS n FROM private_cases WHERE tenant=? AND application=? AND subject=? AND kind=?').get(p.tenant,p.application,p.subject,kind).n;
   if(count>=1000)throw new PrivacyError('RETENTION_CAPACITY',409);
   this.#db.prepare('INSERT INTO private_cases VALUES(?,?,?,?,?,?,?)').run(id,kind,p.tenant,p.application,p.subject,createdAt,bytes);
   this.#db.exec('COMMIT');
  }catch(error){if(this.#db.isTransaction)this.#db.exec('ROLLBACK');throw error;}
  return {id,...value,createdAt:new Date(createdAt).toISOString()};
 }
 async setVisibility(identity,publicProfile){
  const p=principal(identity);if(typeof publicProfile!=='boolean')throw new PrivacyError('INVALID_VISIBILITY');
  this.#db.prepare('INSERT INTO privacy_preferences VALUES(?,?,?,?) ON CONFLICT(tenant,application,subject) DO UPDATE SET public_profile=excluded.public_profile').run(p.tenant,p.application,p.subject,Number(publicProfile));
  return {publicProfile};
 }
 async complain(identity,input,operationId){
  const p=principal(identity),value=complaint(input);if(!valid(operationId)||operationId.length<20)throw new PrivacyError('IDEMPOTENCY_KEY_REQUIRED');
  const id=createHash('sha256').update(JSON.stringify(['TrackZero-complaint-v1',p,operationId])).digest('hex');
  return this.#save(p,id,'complaint',value);
 }
 async recordDecision(operator,input){
  const actor=principal(operator),target=principal(input),value=decision({outcome:input.outcome,explanation:input.explanation,operatorId:actor.subject});
  if(actor.tenant!==target.tenant||actor.application!==target.application||await this.#authorize(actor,Object.freeze({...target,...value}))!==true)throw new PrivacyError('MODERATOR_DENIED',403);
  const result=await this.#save(target,randomUUID(),'decision',value,()=>this.#authorize(actor,Object.freeze({...target,...value})));delete result.operatorId;return result;
 }
 async own(identity,{afterComplaintId=null,afterDecisionId=null}={}){
  const p=principal(identity),args=[p.tenant,p.application,p.subject];
  const page=async(kind,cursor)=>{
   if(cursor!==null&&!valid(cursor))throw new PrivacyError('INVALID_CURSOR');
   let offset=0;if(cursor!==null){const row=this.#db.prepare('SELECT rowid AS n FROM private_cases WHERE tenant=? AND application=? AND subject=? AND kind=? AND id=?').get(...args,kind,cursor);if(!row)throw new PrivacyError('INVALID_CURSOR');offset=row.n;}
   const rows=this.#db.prepare('SELECT rowid,* FROM private_cases WHERE tenant=? AND application=? AND subject=? AND kind=? AND rowid>? ORDER BY rowid LIMIT 3').all(...args,kind,offset);
   const values=[];for(const row of rows.slice(0,2)){const value=await this.#decode(row);delete value.operatorId;values.push({id:row.id,...value,createdAt:new Date(row.created_at).toISOString()});}
   return {values,next:rows.length>2?rows[1].id:null};
  };
  const complaints=await page('complaint',afterComplaintId),decisions=await page('decision',afterDecisionId);
  const preference=this.#db.prepare('SELECT public_profile FROM privacy_preferences WHERE tenant=? AND application=? AND subject=?').get(...args);
  return {publicProfile:preference?.public_profile===1,complaints:complaints.values,decisions:decisions.values,nextComplaintId:complaints.next,nextDecisionId:decisions.next};
 }
}
export function createPrivacyHandler(store,authenticate,codecs){
 if(!(store instanceof PrivacyStore)||typeof authenticate!=='function')throw Error('Authenticated privacy store required');
 const boundary=createPrivateBoundary(codecs);
 return async request=>{
  const url=new URL(request.url);let actor;
  const plain=(status,error)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  try{
   actor=principal(await authenticate(request));const context={action:'privacy',operationId:request.headers.get('idempotency-key')??'read'};
   const respond=async(status,value)=>boundary.respond(status,actor,value,context);
   if(request.method==='GET'&&url.pathname==='/v1/privacy'){
    if([...url.searchParams.keys()].some(k=>!['afterComplaintId','afterDecisionId'].includes(k)))throw new PrivacyError('INVALID_CURSOR');
    return await respond(200,await store.own(actor,{afterComplaintId:url.searchParams.get('afterComplaintId'),afterDecisionId:url.searchParams.get('afterDecisionId')}));
   }
   if(request.method!=='POST'||!['/v1/privacy/preferences','/v1/complaints'].includes(url.pathname))return plain(404,'NOT_FOUND');
   if(request.headers.get('origin')!==url.origin)throw new PrivacyError('ORIGIN_DENIED',403);
   const body=await boundary.read(request,actor,{...context,path:url.pathname});
   if(url.pathname==='/v1/privacy/preferences'){
    if(!exact(body,['publicProfile']))throw new PrivacyError('INVALID_BODY');
    return await respond(200,await store.setVisibility(actor,body.publicProfile));
   }
   return await respond(201,await store.complain(actor,body,request.headers.get('idempotency-key')));
  }catch(error){return error instanceof PrivacyError||error instanceof BoundaryError?plain(error.status,error.code):plain(503,'PRIVACY_UNAVAILABLE');}
 };
}
