import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
export class PrivacyError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function principal(p){
  if(!p||![p.tenant,p.application,p.subject].every(valid))
    throw new PrivacyError('UNAUTHENTICATED',401);
  return {tenant:p.tenant,application:p.application,subject:p.subject};
}

/** Scoped local records. Only the host's operator path may record decisions. */
export class PrivacyStore{
  constructor(filename){
    if(typeof filename!=='string'||!filename)throw Error('Database filename required');
    this.db=new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS privacy_preferences (
      tenant TEXT NOT NULL, application TEXT NOT NULL, subject TEXT NOT NULL,
      public_profile INTEGER NOT NULL CHECK(public_profile IN (0,1)),
      PRIMARY KEY(tenant,application,subject));
      CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL, subject TEXT NOT NULL,
      target TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_decisions (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL, subject TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('WARNING','RESTRICTION','RESTORED')),
      explanation TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  close(){this.db.close();}
  setVisibility(identity,publicProfile){
    const p=principal(identity);
    if(typeof publicProfile!=='boolean')throw new PrivacyError('INVALID_VISIBILITY');
    this.db.prepare(`INSERT INTO privacy_preferences VALUES(?,?,?,?)
      ON CONFLICT(tenant,application,subject) DO UPDATE SET public_profile=excluded.public_profile`)
      .run(p.tenant,p.application,p.subject,Number(publicProfile));
    return this.own(p);
  }
  complain(identity,{target,reason}={}){
    const p=principal(identity);
    if(!valid(target)||typeof reason!=='string'||reason.trim().length<10||reason.length>1000)
      throw new PrivacyError('INVALID_COMPLAINT');
    const id=randomUUID(),createdAt=new Date().toISOString();
    this.db.prepare('INSERT INTO complaints VALUES(?,?,?,?,?,?,?)')
      .run(id,p.tenant,p.application,p.subject,target,reason.trim(),createdAt);
    return {id,target,reason:reason.trim(),createdAt};
  }
  recordDecision({tenant,application,subject,outcome,explanation}){
    const p=principal({tenant,application,subject});
    if(!['WARNING','RESTRICTION','RESTORED'].includes(outcome)||
      typeof explanation!=='string'||explanation.trim().length<10||explanation.length>1000)
      throw new PrivacyError('INVALID_DECISION');
    const id=randomUUID();
    this.db.prepare('INSERT INTO account_decisions VALUES(?,?,?,?,?,?,?)')
      .run(id,p.tenant,p.application,p.subject,outcome,explanation.trim(),new Date().toISOString());
    return id;
  }
  own(identity){
    const p=principal(identity),args=[p.tenant,p.application,p.subject];
    const preference=this.db.prepare(`SELECT public_profile FROM privacy_preferences
      WHERE tenant=? AND application=? AND subject=?`).get(...args);
    const complaints=this.db.prepare(`SELECT id,target,reason,created_at AS createdAt FROM complaints
      WHERE tenant=? AND application=? AND subject=? ORDER BY created_at,id`).all(...args);
    const decisions=this.db.prepare(`SELECT id,outcome,explanation,created_at AS createdAt FROM account_decisions
      WHERE tenant=? AND application=? AND subject=? ORDER BY created_at,id`).all(...args);
    return {publicProfile:preference?.public_profile===1,complaints,decisions};
  }
}

export function createPrivacyHandler(store,authenticate){
  if(!(store instanceof PrivacyStore)||typeof authenticate!=='function')throw Error('Authenticated privacy store required');
  return async request=>{
    const url=new URL(request.url);
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers:{
      'content-type':'application/json','cache-control':'no-store'}});
    try{
      const p=principal(await authenticate(request));
      if(request.method==='GET'&&url.pathname==='/v1/privacy')return respond(200,store.own(p));
      if(request.method!=='POST'||!['/v1/privacy/preferences','/v1/complaints'].includes(url.pathname))
        return respond(404,{error:'NOT_FOUND'});
      if(request.headers.get('origin')!==url.origin)throw new PrivacyError('ORIGIN_DENIED',403);
      const raw=await request.text();if(raw.length>2048)throw new PrivacyError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(raw)}catch{throw new PrivacyError('INVALID_JSON')}
      if(!body||typeof body!=='object'||Array.isArray(body))throw new PrivacyError('INVALID_BODY');
      if(url.pathname==='/v1/privacy/preferences'){
        if(Object.keys(body).join(',')!=='publicProfile')throw new PrivacyError('INVALID_BODY');
        return respond(200,store.setVisibility(p,body.publicProfile));
      }
      if(Object.keys(body).sort().join(',')!=='reason,target')throw new PrivacyError('INVALID_BODY');
      return respond(201,store.complain(p,body));
    }catch(error){return error instanceof PrivacyError?respond(error.status,{error:error.code}):
      respond(503,{error:'PRIVACY_UNAVAILABLE'});}
  };
}
