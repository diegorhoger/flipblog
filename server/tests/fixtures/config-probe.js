// Config probe fixture: resolve the application config as a fresh process would
// and print dbPath + isMemoryDb so tests can verify they agree for a given
// DB_PATH. No secrets or diagnostics are printed.
import { config, isMemoryDb } from '../../src/config.js';

const summary = { dbPath: config.dbPath, isMemoryDb };
process.stdout.write(JSON.stringify(summary));
