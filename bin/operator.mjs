// Operator provisioning against the local data directory (same stores the
// server uses). Usage examples:
//   npm run operator -- invitation artist
//   npm run operator -- station-claim <station-id> <owner-subject>
//   npm run operator -- grant <subject> rights_reviewer|sponsor|moderator
//   npm run operator -- revoke-grant <subject> <role>
//   npm run operator -- engine-credential <engine-id> <station-id>
//   npm run operator -- revoke-engine <engine-id>
import {join} from 'node:path';
import {OnboardingStore} from '../src/onboarding.mjs';
import {StationCatalog} from '../src/station-catalog.mjs';
import {GrantStore} from '../src/platform/grants.mjs';
import {createOperatorOperations} from '../src/platform/operator.mjs';

const dataDir = process.env.TZ_DATA_DIR;
if (!dataDir) { console.error('TZ_DATA_DIR required'); process.exit(1); }
const scope = {tenant: process.env.TZ_TENANT || 'trackzero', application: process.env.TZ_APPLICATION || 'trackzero'};
const onboarding = new OnboardingStore(join(dataDir, 'onboarding.sqlite'));
// Read/claim access only; offers are never published from the CLI.
const catalog = new StationCatalog(join(dataDir, 'catalog.sqlite'), {verifyOfferRights: async () => false});
const grants = new GrantStore(join(dataDir, 'grants.sqlite'));
const ops = createOperatorOperations({scope, onboarding, catalog, grants});
const [command, a, b] = process.argv.slice(2);
try {
  const result = command === 'invitation' ? ops.invitation({role: a}) :
    command === 'station-claim' ? ops.stationClaim({stationId: a, ownerSubject: b}) :
    command === 'grant' ? ops.grant({subject: a, role: b}) :
    command === 'revoke-grant' ? ops.revokeGrant({subject: a, role: b}) :
    command === 'engine-credential' ? ops.engineCredential({engineId: a, stationId: b}) :
    command === 'revoke-engine' ? ops.revokeEngineCredential({engineId: a}) : null;
  if (!result) { console.error('Unknown command; see bin/operator.mjs header'); process.exitCode = 2; }
  else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Operator command failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally { onboarding.close(); catalog.close(); grants.close(); }
