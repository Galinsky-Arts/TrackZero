import test from 'node:test';
import assert from 'node:assert/strict';
import {renderReport,createReportHandler} from '../src/reporting.mjs';

const identity={tenant:'tenant-a',application:'trackzero',userId:'u1',roles:['artist']};
const report={tenant:'tenant-a',application:'trackzero',kind:'artist',subjectId:'artist-a',
  title:'Artist <A>',metrics:{output:{count:'42',source:'OUTPUT_ISSUER',
    evidenceId:'output-1',observedAt:'2026-11-01T00:00:00Z'},transactions:null,campaign:null}};
const request=new Request('https://app.example.test/v1/reports/artist/artist-a?tenant=tenant-b');

test('authorized report renders only evidence-backed counts and unknown sections',async()=>{
  let seen;
  const handle=createReportHandler({authenticate:async()=>identity,
    authorizeReport:async(_actor,scope)=>{seen=scope;return true;},loadReport:async()=>report});
  const response=await handle(request);
  assert.equal(response.status,200);
  assert.deepEqual(seen,{tenant:'tenant-a',application:'trackzero',kind:'artist',subjectId:'artist-a'});
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  const html=await response.text();
  assert.match(html,/Artist &lt;A&gt;/);assert.match(html,/Verified output contributions: 42/);
  assert.match(html,/Processor transactions: unavailable/);
  assert.doesNotMatch(html,/tenant-b|<script|payment amount/);
});

test('authorization and cross-scope issuer mismatches fail closed',async()=>{
  const denied=createReportHandler({authenticate:async()=>identity,authorizeReport:async()=>false,
    loadReport:async()=>{throw Error('must not load')}});
  assert.equal((await denied(request)).status,403);
  const forged=createReportHandler({authenticate:async()=>identity,authorizeReport:async()=>true,
    loadReport:async()=>({...report,tenant:'tenant-b'})});
  assert.equal((await forged(request)).status,503);
  const unknown=createReportHandler({authenticate:async()=>null,authorizeReport:async()=>true,
    loadReport:async()=>report});
  assert.equal((await unknown(request)).status,401);
});

test('unverified source, malformed counts and false zero are rejected',()=>{
  for(const metric of [{...report.metrics.output,source:'CLIENT'},
    {...report.metrics.output,count:'-1'},
    {...report.metrics.output,evidenceId:''},
    {...report.metrics.output,observedAt:'yesterday'}])
    assert.throws(()=>renderReport({...report,metrics:{...report.metrics,output:metric}}));
});
