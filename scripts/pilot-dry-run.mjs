// TZ-23 pilot dry run (software only, fixture verifiers). Prints a labelled JSON
// report; exit code 1 if any software stage fails. Never field evidence.
import {runPilotDryRun} from '../src/platform/pilot-dry-run.mjs';
const report = await runPilotDryRun();
console.log(JSON.stringify(report, null, 2));
if (!report.softwarePassed) process.exitCode = 1;
