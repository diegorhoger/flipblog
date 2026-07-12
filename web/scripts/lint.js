import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [fileURLToPath(new URL('../src', import.meta.url))];

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (['.js', '.mjs', '.cjs'].includes(extname(full))) out.push(full);
  }
  return out;
}

let failed = 0;
for (const root of roots) {
  for (const file of collect(root)) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed++;
      process.stderr.write(`SYNTAX ERROR: ${file}\n${err.stderr?.toString() ?? err.message}\n`);
    }
  }
}

if (failed) {
  process.stderr.write(`\n${failed} file(s) failed syntax check.\n`);
  process.exit(1);
}
process.stdout.write('web: syntax check passed for all source files.\n');
