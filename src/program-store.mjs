import {DatabaseSync} from 'node:sqlite';
import {validateProgram} from './program-sequence.mjs';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class ProgramError extends Error{
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
function actor(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    !['tenant','application','subject'].every(key=>typeof value[key]==='string'&&id.test(value[key])))
    throw new ProgramError('UNAUTHENTICATED',401);
  if(!Array.isArray(value.roles)||!value.roles.includes('broadcaster'))throw new ProgramError('BROADCASTER_ROLE_REQUIRED',403);
  return {tenant:value.tenant,application:value.application,subject:value.subject};
}

/** Local optimistic schedule store. Authorization is rechecked inside each
 * write transaction; actual DRE scheduling and rights checks remain external. */
export class ProgramStore{
  constructor(filename,{authorizeStation,authorizeItem}={}){
    if(typeof filename!=='string'||!filename||typeof authorizeStation!=='function'||typeof authorizeItem!=='function')throw new Error('Store, station and item authorizers required');
    this.authorizeStation=authorizeStation;
    this.authorizeItem=authorizeItem;
    this.db=new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS programs(
      tenant TEXT NOT NULL,application TEXT NOT NULL,station_id TEXT NOT NULL,
      version INTEGER NOT NULL,items_json TEXT NOT NULL,
      PRIMARY KEY(tenant,application,station_id)
    );`);
  }
  close(){this.db.close();}
  #authorize(verifiedActor,stationId){
    const scope=actor(verifiedActor);
    if(typeof stationId!=='string'||!id.test(stationId))throw new ProgramError('INVALID_STATION');
    if(this.authorizeStation(scope,stationId)!==true)throw new ProgramError('STATION_ACCESS_DENIED',403);
    return scope;
  }
  read(verifiedActor,stationId){
    const scope=this.#authorize(verifiedActor,stationId);
    const row=this.db.prepare('SELECT version,items_json FROM programs WHERE tenant=? AND application=? AND station_id=?')
      .get(scope.tenant,scope.application,stationId);
    return row?{version:row.version,items:JSON.parse(row.items_json)}:{version:0,items:[]};
  }
  save(verifiedActor,stationId,{expectedVersion,items}){
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new ProgramError('INVALID_VERSION');
    let normalized;try{normalized=validateProgram(items);}catch{throw new ProgramError('INVALID_PROGRAM');}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const scope=this.#authorize(verifiedActor,stationId);
      if(normalized.some(item=>this.authorizeItem(scope,stationId,item)!==true))throw new ProgramError('PROGRAM_ITEM_DENIED',403);
      const previous=this.db.prepare('SELECT version FROM programs WHERE tenant=? AND application=? AND station_id=?')
        .get(scope.tenant,scope.application,stationId);
      if((previous?.version??0)!==expectedVersion)throw new ProgramError('VERSION_CONFLICT',409);
      const version=expectedVersion+1;
      if(previous)this.db.prepare('UPDATE programs SET version=?,items_json=? WHERE tenant=? AND application=? AND station_id=?')
        .run(version,JSON.stringify(normalized),scope.tenant,scope.application,stationId);
      else this.db.prepare('INSERT INTO programs(tenant,application,station_id,version,items_json) VALUES(?,?,?,?,?)')
        .run(scope.tenant,scope.application,stationId,version,JSON.stringify(normalized));
      this.db.exec('COMMIT');return {version,items:normalized};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}

export function createProgramHandler(store,authenticate){
  if(!(store instanceof ProgramStore)||typeof authenticate!=='function')throw new Error('Authenticated program store required');
  return async function handle(request){
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store'};
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(!url.pathname.startsWith('/v1/programs/'))return respond(404,{error:'NOT_FOUND'});
      const stationId=url.pathname.slice('/v1/programs/'.length),identity=await authenticate(request);
      if(request.method==='GET')return respond(200,store.read(identity,stationId));
      if(request.method!=='PUT')return respond(405,{error:'METHOD_NOT_ALLOWED'});
      if(request.headers.get('origin')!==url.origin)throw new ProgramError('ORIGIN_DENIED',403);
      const text=await request.text();if(Buffer.byteLength(text,'utf8')>100_000)throw new ProgramError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(text);}catch{throw new ProgramError('INVALID_JSON');}
      if(!body||typeof body!=='object'||Array.isArray(body)||
        ['tenant','application','subject','roles'].some(key=>key in body))throw new ProgramError('CLIENT_IDENTITY_FORBIDDEN',403);
      return respond(200,store.save(identity,stationId,body));
    }catch(error){return error instanceof ProgramError?respond(error.status,{error:error.code}):
      respond(503,{error:'PROGRAM_UNAVAILABLE'});}
  };
}
