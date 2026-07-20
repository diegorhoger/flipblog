// Test fixture: performs exactly ONE startup backup of the database at DB_PATH
// into BACKUP_DIR with the given VERSION and TS (both supplied by the parent so
// two concurrently-launched processes can use the SAME timestamp/version/dir to
// exercise the race-safe naming). Prints the resulting backup name to stdout and
// exits non-zero on any failure.
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../../src/db-backup.js';

const dbPath = process.env.DB_PATH;
const db = new DatabaseSync(dbPath);
const result = backupDatabase(db, {
  dbPath,
  backupDir: process.env.BACKUP_DIR,
  version: Number(process.env.VERSION) || 0,
  retention: Number(process.env.RETENTION) || 5,
  ts: process.env.TS,
});
process.stdout.write(JSON.stringify({ name: result && result.name }));
db.close();
