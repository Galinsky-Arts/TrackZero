import {DatabaseSync} from 'node:sqlite';
import {prepareInterstitialDraft} from './interstitial.mjs';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class InterstitialError extends Error{
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
function actor(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    !['tenant','application','subject'].every(key=>typeof value[key]==='string'&&id.test(value[key])))
    throw new InterstitialError('UNAUTHENTICATED',401);
  if(!Array.isArray(value.roles)||!value.roles.includes('broadcaster'))
    throw new InterstitialError('BROADCASTER_ROLE_REQUIRED',403);
  return {tenant:value.tenant,application:value.application,subject:value.subject};
}

/** Quarantine metadata only. No audio bytes, keys, rights assertion or release
 * path is accepted before the authorized encrypted-media endpoint exists. */
export class InterstitialDraftStore{
  constructor(filename,{authorizeStation}={}){
    if(typeof filename!=='string'||!filename||typeof authorizeStation!=='function')throw new Error('Store and station authorizer required');
    this.authorizeStation=authorizeStation;this.db=new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS interstitial_drafts(
      tenant TEXT NOT NULL,application TEXT NOT NULL,station_id TEXT NOT NULL,clip_id TEXT NOT NULL,
      owner_subject TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(tenant,application,station_id,clip_id)
    );`);
  }
  close(){this.db.close();}
  #scope(verifiedActor,stationId){
    const scope=actor(verifiedActor);
    if(typeof stationId!=='string'||!id.test(stationId)||this.authorizeStation(scope,stationId)!==true)
      throw new InterstitialError('STATION_ACCESS_DENIED',403);
    return scope;
  }
  create(verifiedActor,input,nowMs=Date.now()){
    let draft;try{draft=prepareInterstitialDraft(input,nowMs);}catch{throw new InterstitialError('INVALID_DRAFT');}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const scope=this.#scope(verifiedActor,draft.stationId);
      this.db.prepare(`INSERT INTO interstitial_drafts(tenant,application,station_id,clip_id,owner_subject,metadata_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?)`).run(scope.tenant,scope.application,draft.stationId,draft.clipId,
          scope.subject,JSON.stringify(draft),nowMs);
      this.db.exec('COMMIT');return draft;
    }catch(error){this.db.exec('ROLLBACK');
      if(error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message))throw new InterstitialError('DRAFT_EXISTS',409);
      throw error;}
  }
  get(verifiedActor,stationId,clipId){
    const scope=this.#scope(verifiedActor,stationId);
    if(typeof clipId!=='string'||!id.test(clipId))throw new InterstitialError('INVALID_CLIP');
    const row=this.db.prepare('SELECT owner_subject,metadata_json FROM interstitial_drafts WHERE tenant=? AND application=? AND station_id=? AND clip_id=?')
      .get(scope.tenant,scope.application,stationId,clipId);
    if(!row||row.owner_subject!==scope.subject)throw new InterstitialError('DRAFT_NOT_FOUND',404);
    return JSON.parse(row.metadata_json);
  }
}

export function createInterstitialHandler(store,authenticate){
  if(!(store instanceof InterstitialDraftStore)||typeof authenticate!=='function')throw new Error('Authenticated draft store required');
  return async function handle(request){
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store'};
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(request.method==='GET'&&url.pathname.startsWith('/v1/interstitials/')){
        const [, , , stationId, clipId]=url.pathname.split('/');
        return respond(200,store.get(await authenticate(request),stationId,clipId));
      }
      if(request.method!=='POST'||url.pathname!=='/v1/interstitials')return respond(404,{error:'NOT_FOUND'});
      if(request.headers.get('origin')!==url.origin)throw new InterstitialError('ORIGIN_DENIED',403);
      const identity=await authenticate(request),text=await request.text();
      if(text.length>4096)throw new InterstitialError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(text);}catch{throw new InterstitialError('INVALID_JSON');}
      if(!body||typeof body!=='object'||Array.isArray(body)||
        ['tenant','application','subject','roles','media','plaintext','key'].some(key=>key in body))
        throw new InterstitialError('CLIENT_IDENTITY_OR_MEDIA_FORBIDDEN',403);
      return respond(201,store.create(identity,body));
    }catch(error){return error instanceof InterstitialError?respond(error.status,{error:error.code}):
      respond(503,{error:'INTERSTITIAL_UNAVAILABLE'});}
  };
}
