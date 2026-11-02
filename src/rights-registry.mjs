import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mayPublishCatalogItem} from './rights-review.mjs';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const version = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha256 = /^[a-f0-9]{64}$/i;
const allowedUses = Object.freeze(['broadcast','cache','reward','sale']);
export class RightsError extends Error {
  constructor(code, status = 400) {super(code); this.code = code; this.status = status;}
}
function principal(value, role) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['tenant','application','subject'].every(key => typeof value[key] === 'string' && id.test(value[key])))
    throw new RightsError('UNAUTHENTICATED', 401);
  if (!Array.isArray(value.roles) || !value.roles.includes(role)) throw new RightsError('ROLE_DENIED', 403);
  return {tenant:value.tenant, application:value.application, subject:value.subject};
}
function item(value) {
  if (typeof value !== 'string' || !id.test(value)) throw new RightsError('INVALID_ITEM');
  return value;
}
function region(value) {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) throw new RightsError('INVALID_REGION');
  return value;
}

/** Local durable approval ledger. Provider authentication and document review
 * are required external adapters; raw rights documents are never stored here. */
export class RightsRegistry {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename) throw new Error('Database filename required');
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS rights_cases (
      tenant TEXT NOT NULL, application TEXT NOT NULL, item_id TEXT NOT NULL, region TEXT NOT NULL,
      owner_subject TEXT NOT NULL, license_version TEXT NOT NULL, evidence_digest TEXT NOT NULL,
      granted_uses TEXT NOT NULL, rights_valid_from_ms INTEGER NOT NULL, rights_valid_until_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','DENIED','WITHDRAWN')),
      reviewed_by TEXT, reviewed_at_ms INTEGER, valid_until_ms INTEGER, withdrawn_at_ms INTEGER,
      PRIMARY KEY(tenant,application,item_id,region)
    );
    CREATE TABLE IF NOT EXISTS rights_events (
      event_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL,
      item_id TEXT NOT NULL, region TEXT NOT NULL, kind TEXT NOT NULL,
      actor_subject TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL
    );`);
  }
  close() {this.db.close();}
  #case(scope,itemId,area) {
    return this.db.prepare('SELECT * FROM rights_cases WHERE tenant=? AND application=? AND item_id=? AND region=?')
      .get(scope.tenant,scope.application,itemId,area);
  }
  #lastEventMs(scope,itemId,area) {
    return this.db.prepare('SELECT MAX(occurred_at_ms) AS value FROM rights_events WHERE tenant=? AND application=? AND item_id=? AND region=?')
      .get(scope.tenant,scope.application,itemId,area).value;
  }
  #event(scope,itemId,area,kind,nowMs) {
    this.db.prepare('INSERT INTO rights_events(event_id,tenant,application,item_id,region,kind,actor_subject,occurred_at_ms) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(),scope.tenant,scope.application,itemId,area,kind,scope.subject,nowMs);
  }
  submitClaim(verifiedActor,{itemId,region:area,licenseVersion,evidenceDigest,uses,rightsValidFromMs,rightsValidUntilMs},nowMs=Date.now()) {
    const scope=principal(verifiedActor, verifiedActor?.roles?.includes('artist') ? 'artist' : 'label');
    itemId=item(itemId);area=region(area);
    if(typeof licenseVersion!=='string'||!version.test(licenseVersion)||
       typeof evidenceDigest!=='string'||!sha256.test(evidenceDigest)||
       !Array.isArray(uses)||uses.length===0||uses.some(use=>!allowedUses.includes(use))||new Set(uses).size!==uses.length||
       !Number.isSafeInteger(rightsValidFromMs)||!Number.isSafeInteger(rightsValidUntilMs)||rightsValidFromMs<=0||rightsValidUntilMs<=rightsValidFromMs||
       !Number.isSafeInteger(nowMs)||nowMs<=0)throw new RightsError('INVALID_CLAIM');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.#case(scope,itemId,area))throw new RightsError('CLAIM_EXISTS',409);
      this.db.prepare(`INSERT INTO rights_cases(tenant,application,item_id,region,owner_subject,license_version,evidence_digest,granted_uses,rights_valid_from_ms,rights_valid_until_ms,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING')`).run(scope.tenant,scope.application,itemId,area,scope.subject,licenseVersion,evidenceDigest.toLowerCase(),JSON.stringify([...uses].sort()),rightsValidFromMs,rightsValidUntilMs);
      this.#event(scope,itemId,area,'SUBMITTED',nowMs);
      this.db.exec('COMMIT');return {itemId,region:area,state:'PENDING'};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  review(verifiedReviewer,{itemId,region:area,approved,validUntilMs},nowMs=Date.now()) {
    const scope=principal(verifiedReviewer,'rights_reviewer');itemId=item(itemId);area=region(area);
    if(typeof approved!=='boolean'||!Number.isSafeInteger(nowMs)||nowMs<=0||
       (approved&&(!Number.isSafeInteger(validUntilMs)||validUntilMs<=nowMs||validUntilMs>nowMs+366*86400_000)))
      throw new RightsError('INVALID_REVIEW');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claim=this.#case(scope,itemId,area);
      if(!claim||claim.state!=='PENDING')throw new RightsError('PENDING_CLAIM_REQUIRED',409);
      if(nowMs<this.#lastEventMs(scope,itemId,area))throw new RightsError('NON_MONOTONIC_EVENT',409);
      if(claim.owner_subject===scope.subject)throw new RightsError('SELF_REVIEW_DENIED',403);
      this.db.prepare('UPDATE rights_cases SET state=?,reviewed_by=?,reviewed_at_ms=?,valid_until_ms=? WHERE tenant=? AND application=? AND item_id=? AND region=?')
        .run(approved?'APPROVED':'DENIED',scope.subject,nowMs,approved?validUntilMs:null,scope.tenant,scope.application,itemId,area);
      this.#event(scope,itemId,area,approved?'APPROVED':'DENIED',nowMs);
      this.db.exec('COMMIT');return {itemId,region:area,state:approved?'APPROVED':'DENIED'};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  withdraw(verifiedActor,{itemId,region:area},nowMs=Date.now()) {
    if(!Number.isSafeInteger(nowMs)||nowMs<=0)throw new RightsError('INVALID_WITHDRAWAL');
    if(!verifiedActor||typeof verifiedActor!=='object'||!Array.isArray(verifiedActor.roles))
      throw new RightsError('UNAUTHENTICATED',401);
    const role=verifiedActor.roles.includes('rights_reviewer')?'rights_reviewer':
      verifiedActor.roles.includes('artist')?'artist':'label';
    const scope=principal(verifiedActor,role);itemId=item(itemId);area=region(area);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claim=this.#case(scope,itemId,area);
      if(!claim)throw new RightsError('CLAIM_NOT_FOUND',404);
      if(nowMs<this.#lastEventMs(scope,itemId,area))throw new RightsError('NON_MONOTONIC_EVENT',409);
      if(scope.subject!==claim.owner_subject&&!verifiedActor.roles.includes('rights_reviewer'))
        throw new RightsError('OWNER_OR_REVIEWER_REQUIRED',403);
      if(claim.state==='WITHDRAWN'){this.db.exec('COMMIT');return {itemId,region:area,state:'WITHDRAWN',replay:true};}
      this.db.prepare(`UPDATE rights_cases SET state='WITHDRAWN',withdrawn_at_ms=? WHERE tenant=? AND application=? AND item_id=? AND region=?`)
        .run(nowMs,scope.tenant,scope.application,itemId,area);
      this.#event(scope,itemId,area,'WITHDRAWN',nowMs);
      this.db.exec('COMMIT');return {itemId,region:area,state:'WITHDRAWN',replay:false};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  canPublish({tenant,application,itemId,region:area,use},nowMs=Date.now()) {
    if(![tenant,application].every(value=>typeof value==='string'&&id.test(value)))return false;
    try{itemId=item(itemId);area=region(area);}catch{return false;}
    if(!allowedUses.includes(use))return false;
    const claim=this.#case({tenant,application},itemId,area);
    if(!claim||claim.state!=='APPROVED'||!claim.reviewed_by||claim.owner_subject===claim.reviewed_by||
       nowMs<claim.rights_valid_from_ms||nowMs>=claim.rights_valid_until_ms)return false;
    let uses;try{uses=JSON.parse(claim.granted_uses);}catch{return false;}
    if(!Array.isArray(uses)||!uses.includes(use))return false;
    return mayPublishCatalogItem({ownerVerified:true,rightsReviewed:true,rightsApproved:true,
      regionApproved:true,sourceVerified:true,withdrawn:claim.withdrawn_at_ms!==null,
      licenseVersion:claim.license_version,reviewedAtMs:claim.reviewed_at_ms,
      reviewValidUntilMs:claim.valid_until_ms},nowMs);
  }
}

/** Framework-neutral HTTP boundary; authenticate must verify an external
 * session and derive roles server-side. No client identity or role claim is used. */
export function createRightsHandler(registry,authenticate){
  if(!(registry instanceof RightsRegistry)||typeof authenticate!=='function')throw new Error('Authenticated rights registry required');
  return async function handle(request){
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store'};
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(request.method==='GET'&&url.pathname.startsWith('/v1/rights/decisions/')){
        const itemId=url.pathname.slice('/v1/rights/decisions/'.length);
        return respond(200,{publishable:registry.canPublish({itemId,tenant:url.searchParams.get('tenant'),
          application:url.searchParams.get('application'),region:url.searchParams.get('region'),use:url.searchParams.get('use')})});
      }
      if(request.method!=='POST'||!['/v1/rights/claims','/v1/rights/reviews','/v1/rights/withdrawals'].includes(url.pathname))
        return respond(404,{error:'NOT_FOUND'});
      if(request.headers.get('origin')!==url.origin)throw new RightsError('ORIGIN_DENIED',403);
      const actor=await authenticate(request);
      if(!actor)throw new RightsError('UNAUTHENTICATED',401);
      const text=await request.text();
      if(Buffer.byteLength(text,'utf8')>4096)throw new RightsError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(text);}catch{throw new RightsError('INVALID_JSON');}
      if(!body||typeof body!=='object'||Array.isArray(body)||
          ['tenant','application','subject','roles','reviewer'].some(key=>key in body))
        throw new RightsError('CLIENT_IDENTITY_FORBIDDEN',403);
      const result=url.pathname.endsWith('/claims')?registry.submitClaim(actor,body):
        url.pathname.endsWith('/reviews')?registry.review(actor,body):registry.withdraw(actor,body);
      return respond(200,result);
    }catch(error){return error instanceof RightsError?respond(error.status,{error:error.code}):
      respond(503,{error:'RIGHTS_SERVICE_UNAVAILABLE'});}
  };
}
