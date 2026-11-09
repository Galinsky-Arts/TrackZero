import {DatabaseSync} from 'node:sqlite';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const transitions={PRIMARY:new Set(['PRIMARY','FALLBACK']),FALLBACK:new Set(['FALLBACK','RECOVERING']),
  RECOVERING:new Set(['RECOVERING','PRIMARY'])};
export class OperationsError extends Error{
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
function engine(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    !['tenant','application','engineId'].every(key=>typeof value[key]==='string'&&id.test(value[key]))||
    value.role!=='station_engine')throw new OperationsError('ENGINE_AUTH_REQUIRED',403);
  return {tenant:value.tenant,application:value.application,engineId:value.engineId};
}
function clock(nowMs){
  if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new OperationsError('INVALID_CLOCK');
}
function event(value,nowMs){
  clock(nowMs);
  if(!value||typeof value!=='object'||Array.isArray(value)||
    typeof value.stationId!=='string'||!id.test(value.stationId)||
    !Number.isSafeInteger(value.sequence)||value.sequence<1||
    !Number.isSafeInteger(value.scheduleVersion)||value.scheduleVersion<0||
    !Number.isSafeInteger(value.observedAtMs)||value.observedAtMs<0||value.observedAtMs>nowMs+5000||
    value.observedAtMs<nowMs-300_000||!Object.hasOwn(transitions,value.mode)||
    Object.keys(value).sort().join(',')!=='mode,observedAtMs,scheduleVersion,sequence,stationId')
    throw new OperationsError('INVALID_ENGINE_EVENT');
  return value;
}

/** A read model of engine-reported state, never proof of actual live audio. */
export class StationOperations{
  constructor(filename,{authorizeEngine,staleAfterMs=60_000}={}){
    if(typeof filename!=='string'||!filename||typeof authorizeEngine!=='function'||
      !Number.isSafeInteger(staleAfterMs)||staleAfterMs<5000||staleAfterMs>300_000)
      throw new Error('Store, engine authorizer and bounded stale threshold required');
    this.authorizeEngine=authorizeEngine;this.staleAfterMs=staleAfterMs;
    this.db=new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS station_operations(
      tenant TEXT NOT NULL,application TEXT NOT NULL,station_id TEXT NOT NULL,
      engine_id TEXT NOT NULL,sequence INTEGER NOT NULL,schedule_version INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('PRIMARY','FALLBACK','RECOVERING')),
      observed_at_ms INTEGER NOT NULL,PRIMARY KEY(tenant,application,station_id)
    );`);
  }
  close(){this.db.close();}
  ingest(verifiedEngine,value,nowMs=Date.now()){
    const source=engine(verifiedEngine);event(value,nowMs);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.authorizeEngine(source,value.stationId)!==true)
        throw new OperationsError('ENGINE_SCOPE_DENIED',403);
      const previous=this.db.prepare('SELECT * FROM station_operations WHERE tenant=? AND application=? AND station_id=?')
        .get(source.tenant,source.application,value.stationId);
      if(previous&&(
        previous.engine_id!==source.engineId||value.sequence<=previous.sequence||
        value.observedAtMs<previous.observed_at_ms||value.scheduleVersion<previous.schedule_version||
        !transitions[previous.mode].has(value.mode)))throw new OperationsError('STALE_OR_INVALID_TRANSITION',409);
      if(!previous&&value.mode==='RECOVERING')throw new OperationsError('INITIAL_STATE_INVALID',409);
      this.db.prepare(`INSERT INTO station_operations(tenant,application,station_id,engine_id,sequence,schedule_version,mode,observed_at_ms)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant,application,station_id) DO UPDATE SET
        sequence=excluded.sequence,schedule_version=excluded.schedule_version,mode=excluded.mode,
        observed_at_ms=excluded.observed_at_ms`)
        .run(source.tenant,source.application,value.stationId,source.engineId,value.sequence,
          value.scheduleVersion,value.mode,value.observedAtMs);
      this.db.exec('COMMIT');return this.status({...source,stationId:value.stationId},nowMs);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  status({tenant,application,stationId},nowMs=Date.now()){
    clock(nowMs);
    if(![tenant,application,stationId].every(value=>typeof value==='string'&&id.test(value)))
      throw new OperationsError('INVALID_STATION');
    const row=this.db.prepare('SELECT sequence,schedule_version,mode,observed_at_ms FROM station_operations WHERE tenant=? AND application=? AND station_id=?')
      .get(tenant,application,stationId);
    if(!row)return {stationId,state:'UNKNOWN',reason:'NO_ENGINE_REPORT',scheduleVersion:null,observedAtMs:null};
    const stale=nowMs-row.observed_at_ms>this.staleAfterMs||nowMs<row.observed_at_ms-5000;
    return {stationId,state:stale?'STALE':row.mode,reason:stale?'ENGINE_REPORT_STALE':null,
      scheduleVersion:row.schedule_version,observedAtMs:row.observed_at_ms};
  }
}

function escapeHtml(value){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function renderStationStatus(status){
  if(!status||typeof status!=='object'||!['UNKNOWN','STALE','PRIMARY','FALLBACK','RECOVERING'].includes(status.state)||
    typeof status.stationId!=='string'||!id.test(status.stationId)||
    (status.scheduleVersion!==null&&(!Number.isSafeInteger(status.scheduleVersion)||status.scheduleVersion<0)))
    throw new OperationsError('INVALID_STATUS');
  const label={UNKNOWN:'No verified engine report',STALE:'Engine report is stale',PRIMARY:'Primary schedule reported',
    FALLBACK:'Fallback reported',RECOVERING:'Recovery reported'}[status.state];
  return `<section aria-labelledby="station-status-title"><h2 id="station-status-title">Station ${escapeHtml(status.stationId)}</h2>`+
    `<p role="status" aria-live="polite">${label}</p>`+
    `<p>Schedule version: ${status.scheduleVersion===null?'unknown':String(status.scheduleVersion)}</p></section>`;
}

export function createStationOperationsHandler(store,authenticate,{authorizeViewer=()=>false}={}){
  if(!(store instanceof StationOperations)||typeof authenticate!=='function'||typeof authorizeViewer!=='function')throw new Error('Authenticated operations store required');
  return async function handle(request){
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store'};
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(request.method==='GET'&&url.pathname.startsWith('/v1/stations/')&&url.pathname.endsWith('/status')){
        const stationId=url.pathname.slice('/v1/stations/'.length,-'/status'.length);
        const viewer=await authenticate(request);
        if(!viewer||!['tenant','application'].every(k=>typeof viewer[k]==='string'&&id.test(viewer[k])))
          throw new OperationsError('UNAUTHENTICATED',401);
        if([...url.searchParams.keys()].some(k=>['tenant','application'].includes(k))||
          await authorizeViewer(viewer,stationId)!==true)throw new OperationsError('STATION_ACCESS_DENIED',403);
        return respond(200,store.status({stationId,tenant:viewer.tenant,application:viewer.application}));
      }
      if(request.method!=='POST'||url.pathname!=='/v1/station-engine/events')return respond(404,{error:'NOT_FOUND'});
      if(request.headers.get('origin')!==url.origin)throw new OperationsError('ORIGIN_DENIED',403);
      const source=await authenticate(request),text=await request.text();
      if(Buffer.byteLength(text,'utf8')>4096)throw new OperationsError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(text);}catch{throw new OperationsError('INVALID_JSON');}
      if(!body||typeof body!=='object'||Array.isArray(body)||
        ['tenant','application','engineId','role'].some(key=>key in body))
        throw new OperationsError('CLIENT_ENGINE_IDENTITY_FORBIDDEN',403);
      return respond(200,store.ingest(source,body));
    }catch(error){return error instanceof OperationsError?respond(error.status,{error:error.code}):
      respond(503,{error:'STATION_OPERATIONS_UNAVAILABLE'});}
  };
}
