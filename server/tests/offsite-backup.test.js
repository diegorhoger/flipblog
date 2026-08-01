import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  encryptFile,
  decryptFile,
  isValidBackupKey,
  resolveEncryptionKey,
  generateEncryptionKey,
  pushOffsiteBackup,
  listOffsiteBackups,
  newestOffsiteBackup,
  parseOffsiteName,
  offsiteFileName,
} from '../src/offsite-backup.js';
import { backupDatabase } from '../src/db-backup.js';

const TMP = tmpdir();
const KEY = 'a'.repeat(64); // 64 hex chars -> 32 bytes

function newDir(prefix) {
  return mkdtempSync(join(TMP, prefix));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makeBackupFile(dir, name = 'flipblog-pre-v6-20260720T153001.000Z-abc123.db', data = 'hello-backup') {
  const file = join(dir, name);
  writeFileSync(file, data);
  return file;
}

// ---------------------------------------------------------------- key handling

test('isValidBackupKey accepts 64 hex chars', () => {
  assert.equal(isValidBackupKey('a'.repeat(64)), true);
  assert.equal(isValidBackupKey('A'.repeat(64)), true);
});

test('isValidBackupKey accepts 32-byte base64', () => {
  assert.equal(isValidBackupKey(Buffer.alloc(32, 7).toString('base64')), true);
});

test('isValidBackupKey rejects wrong lengths and garbage', () => {
  assert.equal(isValidBackupKey(''), false);
  assert.equal(isValidBackupKey(undefined), false);
  assert.equal(isValidBackupKey(null), false);
  assert.equal(isValidBackupKey('short'), false);
  assert.equal(isValidBackupKey('a'.repeat(63)), false);
  assert.equal(isValidBackupKey('g'.repeat(64)), false); // not hex, not base64
  assert.equal(isValidBackupKey('   '), false);
});

test('resolveEncryptionKey returns a 32-byte buffer', () => {
  const hex = resolveEncryptionKey('b'.repeat(64));
  assert.ok(Buffer.isBuffer(hex));
  assert.equal(hex.length, 32);
  const b64 = resolveEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
  assert.equal(b64.length, 32);
  assert.equal(b64[0], 9);
});

test('resolveEncryptionKey throws on an invalid key', () => {
  assert.throws(() => resolveEncryptionKey('not-a-key'), /BACKUP_OFFSITE_KEY/);
  assert.throws(() => resolveEncryptionKey(''), /BACKUP_OFFSITE_KEY/);
});

test('generateEncryptionKey produces a valid 64-hex key', () => {
  const k = generateEncryptionKey();
  assert.equal(k.length, 64);
  assert.match(k, /^[0-9a-f]+$/);
  assert.equal(isValidBackupKey(k), true);
});

// ---------------------------------------------------------------- encrypt/decrypt

test('encryptFile/decryptFile round-trips a plaintext file', async () => {
  const dir = newDir('fb-enc-');
  const src = join(dir, 'src.db');
  const enc = join(dir, 'out.enc');
  const out = join(dir, 'out.db');
  const data = Buffer.from('the quick brown fox jumps over the lazy dog');
  writeFileSync(src, data);

  await encryptFile(src, Buffer.from(KEY, 'hex'), enc);
  await decryptFile(enc, Buffer.from(KEY, 'hex'), out);

  assert.ok(existsSync(enc));
  assert.ok(existsSync(out));
  assert.deepEqual(readFileSync(out), data, 'decrypted bytes match the original');
  assert.notDeepEqual(readFileSync(enc), data, 'ciphertext differs from plaintext');
  cleanup(dir);
});

test('encrypted file has the expected header/tail layout', async () => {
  const dir = newDir('fb-layout-');
  const src = join(dir, 'src.db');
  writeFileSync(src, 'x'.repeat(1000));
  const enc = join(dir, 'out.enc');
  await encryptFile(src, Buffer.from(KEY, 'hex'), enc);

  const buf = readFileSync(enc);
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'FBE1');
  assert.equal(buf[4], 1, 'format version byte');
  // 4 magic + 1 version + 12 IV + 16 tag = 33 bytes of framing.
  assert.equal(buf.length, 1000 + 33);
  cleanup(dir);
});

test('decryptFile rejects a wrong key', async () => {
  const dir = newDir('fb-wrongkey-');
  const src = join(dir, 'src.db');
  const enc = join(dir, 'out.enc');
  const out = join(dir, 'out.db');
  writeFileSync(src, 'secret data');
  await encryptFile(src, Buffer.from(KEY, 'hex'), enc);
  const otherKey = Buffer.alloc(32, 1).toString('hex');
  await assert.rejects(() => decryptFile(enc, Buffer.from(otherKey, 'hex'), out), /authentication|decryption|wrong key|tampered/i);
  assert.ok(!existsSync(out), 'no plaintext written for a wrong key');
  cleanup(dir);
});

test('decryptFile rejects a truncated file', async () => {
  const dir = newDir('fb-trunc-');
  const src = join(dir, 'src.db');
  const enc = join(dir, 'out.enc');
  const out = join(dir, 'out.db');
  writeFileSync(src, 'data to encrypt for truncation test');
  await encryptFile(src, Buffer.from(KEY, 'hex'), enc);
  const buf = readFileSync(enc);
  writeFileSync(enc, buf.subarray(0, 10)); // cut into the ciphertext
  await assert.rejects(() => decryptFile(enc, Buffer.from(KEY, 'hex'), out), /truncated/);
  cleanup(dir);
});

test('decryptFile rejects an empty file', async () => {
  const dir = newDir('fb-empty-');
  const enc = join(dir, 'out.enc');
  const out = join(dir, 'out.db');
  writeFileSync(enc, '');
  await assert.rejects(() => decryptFile(enc, Buffer.from(KEY, 'hex'), out), /truncated/);
  cleanup(dir);
});

test('decryptFile rejects a file with the wrong magic header', async () => {
  const dir = newDir('fb-magic-');
  const enc = join(dir, 'out.enc');
  const out = join(dir, 'out.db');
  // 33+ bytes of valid length but a bogus header.
  writeFileSync(enc, Buffer.concat([Buffer.from('XXXX', 'ascii'), Buffer.alloc(40, 0)]));
  await assert.rejects(() => decryptFile(enc, Buffer.from(KEY, 'hex'), out), /not a FlipBlog offsite backup/);
  cleanup(dir);
});

test('decryptFile rejects an unsupported format version', async () => {
  const dir = newDir('fb-ver-');
  const enc = join(dir, 'out.enc');
  const out = join(dir, 'out.db');
  const iv = Buffer.alloc(12, 0);
  const tag = Buffer.alloc(16, 0);
  writeFileSync(enc, Buffer.concat([Buffer.from('FBE1', 'ascii'), Buffer.from([9]), iv, Buffer.alloc(4, 0), tag]));
  await assert.rejects(() => decryptFile(enc, Buffer.from(KEY, 'hex'), out), /unsupported offsite backup format/);
  cleanup(dir);
});

// ---------------------------------------------------------------- push / prune / list

test('pushOffsiteBackup encrypts a local backup into the offsite dir', async () => {
  const dir = newDir('fb-push-');
  const localDir = join(dir, 'local');
  const offDir = join(dir, 'offsite');
  mkdirSync(localDir, { recursive: true });
  mkdirSync(offDir, { recursive: true });
  const src = makeBackupFile(localDir, 'flipblog-pre-v6-20260720T153001.000Z-abc123.db', 'payload');

  const manifest = await pushOffsiteBackup({ sourcePath: src, destDir: offDir, key: Buffer.from(KEY, 'hex'), retention: 5 });

  assert.ok(existsSync(manifest.offsitePath));
  assert.match(manifest.offsitePath, /flipblog-pre-v6-20260720T153001\.000Z-abc123\.db\.enc$/);
  assert.equal(manifest.version, 6);
  assert.equal(manifest.ts, '20260720T153001.000Z');

  // Round-trip: the offsite copy decrypts back to the original payload.
  const restored = join(dir, 'restored.db');
  await decryptFile(manifest.offsitePath, Buffer.from(KEY, 'hex'), restored);
  assert.equal(readFileSync(restored, 'utf8'), 'payload');
  cleanup(dir);
});

test('pushOffsiteBackup prunes old offsite copies down to retention', async () => {
  const dir = newDir('fb-push-prune-');
  const localDir = join(dir, 'local');
  const offDir = join(dir, 'offsite');
  mkdirSync(localDir, { recursive: true });
  mkdirSync(offDir, { recursive: true });

  // Seed 4 old offsite backups, then push a 5th with retention 4 -> 1 pruned.
  for (let i = 0; i < 4; i++) {
    const name = `flipblog-pre-v6-2026060${i}T00000${i}.000Z-old${i}.db.enc`;
    writeFileSync(join(offDir, name), 'old');
  }
  const src = makeBackupFile(localDir, 'flipblog-pre-v6-20260720T153001.000Z-new1.db', 'new');
  const manifest = await pushOffsiteBackup({ sourcePath: src, destDir: offDir, key: Buffer.from(KEY, 'hex'), retention: 4 });

  assert.equal(manifest.pruned.length, 1);
  assert.equal(manifest.retained.length, 4);
  const remaining = readdirSync(offDir).filter((n) => n.endsWith('.enc'));
  assert.equal(remaining.length, 4, 'exactly retention copies remain');
  assert.ok(remaining.some((n) => n.includes('new1')), 'the newest push survives');
  cleanup(dir);
});

test('listOffsiteBackups returns newest-first and ignores non-backups', async () => {
  const dir = newDir('fb-list-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'flipblog-pre-v6-20260720T153001.000Z-newest.db.enc'), '');
  writeFileSync(join(dir, 'flipblog-pre-v6-20260701T000000.000Z-older.db.enc'), '');
  writeFileSync(join(dir, 'unrelated.txt'), '');
  writeFileSync(join(dir, 'flipblog-pre-v6-20260720T153001.000Z-newest.db'), ''); // plain, not .enc

  const list = listOffsiteBackups(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'flipblog-pre-v6-20260720T153001.000Z-newest.db.enc');
  assert.equal(list[1].name, 'flipblog-pre-v6-20260701T000000.000Z-older.db.enc');
  assert.equal(newestOffsiteBackup(dir).name, list[0].name);
  cleanup(dir);
});

test('parseOffsiteName round-trips offsiteFileName', () => {
  const local = 'flipblog-pre-v6-20260720T153001.000Z-abc.db';
  const enc = offsiteFileName(local);
  assert.equal(enc, `${local}.enc`);
  const parsed = parseOffsiteName(enc);
  assert.ok(parsed);
  assert.equal(parsed.version, 6);
  assert.equal(parsed.ts, '20260720T153001.000Z');
  assert.equal(parseOffsiteName('not-a-backup.enc'), null);
  assert.equal(parseOffsiteName(local), null, 'plain .db name is not an offsite name');
});

test('an end-to-end backup survives an encrypted offsite round-trip', async () => {
  const dir = newDir('fb-e2e-');
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('survives-offsite');

  const localDir = join(dir, 'local');
  mkdirSync(localDir, { recursive: true });
  const local = backupDatabase(db, { dbPath: file, backupDir: localDir, version: 6, retention: 5 });

  const offDir = join(dir, 'offsite');
  mkdirSync(offDir, { recursive: true });
  const manifest = await pushOffsiteBackup({ sourcePath: local.backupPath, destDir: offDir, key: Buffer.from(KEY, 'hex'), retention: 5 });

  const restored = join(dir, 'restored.db');
  await decryptFile(manifest.offsitePath, Buffer.from(KEY, 'hex'), restored);
  const copy = new DatabaseSync(restored);
  assert.equal(copy.prepare('SELECT v FROM t WHERE id = 1').get().v, 'survives-offsite');
  copy.close();
  db.close();
  cleanup(dir);
});

test('encrypted backups keep their bytes distinct from plaintext', async () => {
  const dir = newDir('fb-distinct-');
  const src = join(dir, 'src.db');
  const enc = join(dir, 'out.enc');
  writeFileSync(src, 'A'.repeat(4096));
  await encryptFile(src, Buffer.from(KEY, 'hex'), enc);
  assert.ok(statSync(enc).size > statSync(src).size, 'ciphertext has framing overhead');
  assert.notDeepEqual(readFileSync(enc), readFileSync(src));
  cleanup(dir);
});
