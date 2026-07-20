// Test fixture: runs the REAL server startup (getDb → backup → baseline →
// migrations → health check) in an isolated child process with backups ENABLED
// (NODE_ENV=production), then reports the backups that were created. Used to
// verify the startup backup wiring end-to-end without polluting the in-process
// module graph. The summary is written to stderr so it is not interleaved with
// the structured backup log lines that the backup module emits on stdout.
import { getDb, closeDb } from '../../src/db.js';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const db = getDb();
const dbPath = process.env.DB_PATH;
const backupDir = join(dirname(dbPath), 'backups');
const backups = existsSync(backupDir) ? readdirSync(backupDir).sort() : [];

process.stderr.write(JSON.stringify({ backups, dbPath }));
closeDb();
