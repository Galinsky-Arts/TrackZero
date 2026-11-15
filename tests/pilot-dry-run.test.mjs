import test from 'node:test';
import assert from 'node:assert/strict';
import {runPilotDryRun, DRY_RUN_LABEL} from '../src/platform/pilot-dry-run.mjs';

test('TZ-23 dry run passes every software stage and is labelled non-field evidence', async () => {
  const report = await runPilotDryRun({now: () => new Date('2026-11-15T12:00:00Z')});
  for (const stage of report.stages) assert.equal(stage.passed, true, `${stage.name}: ${stage.failure ?? ''}`);
  assert.equal(report.softwarePassed, true);
  assert.equal(report.stages.length, 9);
  assert.equal(report.evidenceKind, 'software-dry-run-with-fixture-verifiers');
  assert.equal(report.fieldEvidence, false); assert.equal(report.pilotComplete, false);
  assert.ok(report.fixtureVerifiers.some(text => /introspection stub/.test(text)));
  assert.ok(report.notExercised.some(text => /phones, speakers/.test(text)));
  assert.doesNotMatch(JSON.stringify(report), /tzeng_|Bearer|pilot-dry-run-operator-token/, 'no credentials in the report');
  assert.ok(Object.isFrozen(DRY_RUN_LABEL));
});
