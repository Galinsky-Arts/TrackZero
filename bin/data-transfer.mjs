// Export/import TrackZero's application SQLite stores. Stop the server first.
//   node bin/data-transfer.mjs export <absolute-export-dir>
//   node bin/data-transfer.mjs verify <absolute-export-dir>
//   node bin/data-transfer.mjs import <absolute-export-dir> [--replace]
// Uses TZ_DATA_DIR. Prints file names, digests and row counts only.
import {exportStores, importStores, verifyExport, DataTransferError} from '../src/platform/data-transfer.mjs';

const [command, dir, flag] = process.argv.slice(2);
const dataDir = process.env.TZ_DATA_DIR;
const summary = manifest => manifest.files.map(file => `${file.name} sha256=${file.sha256.slice(0, 16)}… rows=${JSON.stringify(file.tables)}`).join('\n');
try {
  if (command === 'export') {
    if (!dataDir) throw new DataTransferError('TZ_DATA_DIR_REQUIRED');
    const manifest = await exportStores({dataDir, outDir: dir, source: {commit: process.env.RENDER_GIT_COMMIT ?? null}});
    console.log(`Exported ${manifest.files.length} stores to ${dir}\n${summary(manifest)}`);
  } else if (command === 'verify') {
    console.log(`Export verified\n${summary(verifyExport(dir))}`);
  } else if (command === 'import') {
    if (!dataDir) throw new DataTransferError('TZ_DATA_DIR_REQUIRED');
    if (flag !== undefined && flag !== '--replace') throw new DataTransferError('UNKNOWN_OPTION');
    const result = importStores({exportDir: dir, dataDir, replace: flag === '--replace'});
    console.log(`Imported ${result.restored.join(', ')}` + (result.preserved ? `\nPrevious stores preserved in ${result.preserved}` : ''));
  } else {
    console.error('Usage: data-transfer.mjs export|verify|import <absolute-export-dir> [--replace]'); process.exitCode = 2;
  }
} catch (error) {
  console.error('Data transfer failed: ' + (error instanceof DataTransferError ? error.code : 'UNEXPECTED_ERROR'));
  process.exitCode = 1;
}
