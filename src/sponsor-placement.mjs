import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/i;
export class PlacementError extends Error{
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
function principal(value,role){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    !['tenant','application','subject'].every(key=>typeof value[key]==='string'&&id.test(value[key])))
    throw new PlacementError('UNAUTHENTICATED',401);
  if(!Array.isArray(value.roles)||!value.roles.includes(role))throw new PlacementError('ROLE_DENIED',403);
  return {tenant:value.tenant,application:value.application,subject:value.subject};
}
function input(value,nowMs){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    !['stationId','placementId'].every(key=>typeof value[key]==='string'&&id.test(value[key]))||
    typeof value.mediaDigest!=='string'||!sha.test(value.mediaDigest)||
    !Number.isSafeInteger(value.durationMs)||value.durationMs<200||value.durationMs>300_000||
    !Number.isSafeInteger(value.startsAtMs)||!Number.isSafeInteger(value.endsAtMs)||
    value.startsAtMs<=nowMs||value.endsAtMs<=value.startsAtMs||value.endsAtMs>nowMs+366*86400_000)
    throw new PlacementError('INVALID_PLACEMENT');
  if(Object.keys(value).sort().join(',')!==
    'durationMs,endsAtMs,mediaDigest,placementId,startsAtMs,stationId')
    throw new PlacementError('UNEXPECTED_PLACEMENT_FIELDS');
  return value;
}

/** Metadata-only local ledger. Authorizers and media verification must be
 * backed by real provider contracts before any placement is scheduled. */
export class SponsorPlacementStore{
  constructor(filename,{authorizeSponsor,authorizeStation,verifyMedia}={}){
    if(typeof filename!=='string'||!filename||
      [authorizeSponsor,authorizeStation,verifyMedia].some(fn=>typeof fn!=='function'))
      throw new Error('Store and three trusted adapters required');
    this.authorizeSponsor=authorizeSponsor;this.authorizeStation=authorizeStation;this.verifyMedia=verifyMedia;
    this.db=new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sponsor_placements(
      tenant TEXT NOT NULL,application TEXT NOT NULL,station_id TEXT NOT NULL,placement_id TEXT NOT NULL,
      sponsor_subject TEXT NOT NULL,media_digest TEXT NOT NULL,duration_ms INTEGER NOT NULL,
      starts_at_ms INTEGER NOT NULL,ends_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','REVOKED')),
      approved_by TEXT,approved_at_ms INTEGER,revoked_at_ms INTEGER,
      PRIMARY KEY(tenant,application,station_id,placement_id)
    );
    CREATE TABLE IF NOT EXISTS placement_events(
      event_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,application TEXT NOT NULL,
      station_id TEXT NOT NULL,placement_id TEXT NOT NULL,kind TEXT NOT NULL,
      actor_subject TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL
    );`);
  }
  close(){this.db.close();}
  #row(scope,stationId,placementId){return this.db.prepare(`SELECT * FROM sponsor_placements
    WHERE tenant=? AND application=? AND station_id=? AND placement_id=?`)
    .get(scope.tenant,scope.application,stationId,placementId);}
  #event(scope,stationId,placementId,kind,nowMs){this.db.prepare(`INSERT INTO placement_events
    (event_id,tenant,application,station_id,placement_id,kind,actor_subject,occurred_at_ms)
    VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(),scope.tenant,scope.application,stationId,placementId,kind,scope.subject,nowMs);}
  submit(verifiedSponsor,value,nowMs=Date.now()){
    const scope=principal(verifiedSponsor,'sponsor');input(value,nowMs);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.authorizeSponsor(scope,value.stationId)!==true)throw new PlacementError('SPONSOR_ACCESS_DENIED',403);
      this.db.prepare(`INSERT INTO sponsor_placements(tenant,application,station_id,placement_id,sponsor_subject,
        media_digest,duration_ms,starts_at_ms,ends_at_ms,state) VALUES(?,?,?,?,?,?,?,?,?,'PENDING')`)
        .run(scope.tenant,scope.application,value.stationId,value.placementId,scope.subject,
          value.mediaDigest.toLowerCase(),value.durationMs,value.startsAtMs,value.endsAtMs);
      this.#event(scope,value.stationId,value.placementId,'SUBMITTED',nowMs);
      this.db.exec('COMMIT');return {placementId:value.placementId,state:'PENDING',schedulable:false};
    }catch(error){this.db.exec('ROLLBACK');
      if(error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message))throw new PlacementError('PLACEMENT_EXISTS',409);
      throw error;}
  }
  approve(verifiedBroadcaster,{stationId,placementId},nowMs=Date.now()){
    const scope=principal(verifiedBroadcaster,'broadcaster');
    if(!id.test(stationId)||!id.test(placementId))throw new PlacementError('INVALID_PLACEMENT');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.authorizeStation(scope,stationId)!==true)throw new PlacementError('STATION_ACCESS_DENIED',403);
      const row=this.#row(scope,stationId,placementId);
      if(!row||row.state!=='PENDING')throw new PlacementError('PENDING_PLACEMENT_REQUIRED',409);
      if(row.sponsor_subject===scope.subject)throw new PlacementError('SELF_APPROVAL_DENIED',403);
      if(row.ends_at_ms<=nowMs||this.verifyMedia(scope,{stationId,placementId,mediaDigest:row.media_digest})!==true)
        throw new PlacementError('MEDIA_OR_WINDOW_NOT_VERIFIED',403);
      this.db.prepare(`UPDATE sponsor_placements SET state='APPROVED',approved_by=?,approved_at_ms=?
        WHERE tenant=? AND application=? AND station_id=? AND placement_id=?`)
        .run(scope.subject,nowMs,scope.tenant,scope.application,stationId,placementId);
      this.#event(scope,stationId,placementId,'APPROVED',nowMs);
      this.db.exec('COMMIT');return {placementId,state:'APPROVED',schedulable:nowMs>=row.starts_at_ms};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  revoke(verifiedActor,{stationId,placementId},nowMs=Date.now()){
    if(!verifiedActor||typeof verifiedActor!=='object'||!Array.isArray(verifiedActor.roles))
      throw new PlacementError('UNAUTHENTICATED',401);
    const role=verifiedActor.roles.includes('broadcaster')?'broadcaster':'sponsor';
    const scope=principal(verifiedActor,role);
    if(!id.test(stationId)||!id.test(placementId))throw new PlacementError('INVALID_PLACEMENT');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.#row(scope,stationId,placementId);
      if(!row)throw new PlacementError('PLACEMENT_NOT_FOUND',404);
      const broadcaster=role==='broadcaster'&&this.authorizeStation(scope,stationId)===true;
      if(!broadcaster&&row.sponsor_subject!==scope.subject)throw new PlacementError('REVOCATION_DENIED',403);
      if(row.state==='REVOKED'){this.db.exec('COMMIT');return {placementId,state:'REVOKED',replay:true};}
      this.db.prepare(`UPDATE sponsor_placements SET state='REVOKED',revoked_at_ms=?
        WHERE tenant=? AND application=? AND station_id=? AND placement_id=?`)
        .run(nowMs,scope.tenant,scope.application,stationId,placementId);
      this.#event(scope,stationId,placementId,'REVOKED',nowMs);
      this.db.exec('COMMIT');return {placementId,state:'REVOKED',replay:false};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  active({tenant,application,stationId},nowMs=Date.now()){
    if(![tenant,application,stationId].every(value=>typeof value==='string'&&id.test(value)))return [];
    return this.db.prepare(`SELECT placement_id AS placementId,media_digest AS mediaDigest,duration_ms AS durationMs
      FROM sponsor_placements WHERE tenant=? AND application=? AND station_id=? AND state='APPROVED'
      AND starts_at_ms<=? AND ends_at_ms>? ORDER BY starts_at_ms,placement_id`)
      .all(tenant,application,stationId,nowMs,nowMs)
      .filter(row=>this.verifyMedia({tenant,application},{stationId,placementId:row.placementId,mediaDigest:row.mediaDigest})===true);
  }
}

/** Framework-neutral boundary; authenticate must derive provider roles and
 * identity server-side. The response never carries media bytes or a URL. */
export function createSponsorPlacementHandler(store,authenticate){
  if(!(store instanceof SponsorPlacementStore)||typeof authenticate!=='function')
    throw new Error('Authenticated placement store required');
  return async function handle(request){
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store'};
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(request.method==='GET'&&url.pathname==='/v1/sponsor-placements/active')
        return respond(200,{placements:store.active({tenant:url.searchParams.get('tenant'),
          application:url.searchParams.get('application'),stationId:url.searchParams.get('stationId')})});
      if(request.method!=='POST'||!['/v1/sponsor-placements','/v1/sponsor-placements/approve',
        '/v1/sponsor-placements/revoke'].includes(url.pathname))return respond(404,{error:'NOT_FOUND'});
      if(request.headers.get('origin')!==url.origin)throw new PlacementError('ORIGIN_DENIED',403);
      const actor=await authenticate(request),text=await request.text();
      if(text.length>4096)throw new PlacementError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(text);}catch{throw new PlacementError('INVALID_JSON');}
      if(!body||typeof body!=='object'||Array.isArray(body)||
        ['tenant','application','subject','roles','media','plaintext','key'].some(key=>key in body))
        throw new PlacementError('CLIENT_IDENTITY_OR_MEDIA_FORBIDDEN',403);
      const result=url.pathname.endsWith('/approve')?store.approve(actor,body):
        url.pathname.endsWith('/revoke')?store.revoke(actor,body):store.submit(actor,body);
      return respond(200,result);
    }catch(error){return error instanceof PlacementError?respond(error.status,{error:error.code}):
      respond(503,{error:'PLACEMENT_UNAVAILABLE'});}
  };
}
