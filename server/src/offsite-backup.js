import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, openSync, readSync, closeSync, statSync } from 'node:fs';import { basename, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from './logging.js';
import { parseBackupName } from './db-backup.js';

// --- Offsite (encrypted) backups --------------------------------------------
//
// The local startup backup lives next to the application database and is not a
// disaster-recovery destination: it is the rollback safety net for migrations
// on the SAME disk. Offsite backups are encrypted copies of a local backup that
// live in a destination independent of the application disk (a mounted volume,
// object-store mount, or network share), so losing the app disk does not lose
// the data.
//
// Format (v1): AES-256-GCM authenticated encryption.
//
//   header   MAGIC(4) + VERSION(1) + IV(12)          = 17 bytes
//   body     ciphertext of the source backup file
//   tail     auth tag (16 bytes)
//
// The auth tag is written last so decryption can stream: the header and the
// final 16 bytes are read first, then the middle is streamed through the
// decipher. Any truncation, tampering, or wrong-key decrypt fails closed with
// an authentication error — a partial or corrupted offsite backup is never
// silently restored.

const MAGIC = Buffer.from('FBE1', 'ascii');
const FORMAT_VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + IV_LEN; // 17
const OFF_SITE_SUFFIX = '.enc';

// An offsite copy keeps the local backup's canonical name and appends `.enc`:
//   flipblog-pre-v6-<ts>-<attempt>.db   ->   flipblog-pre-v6-<ts>-<attempt>.db.enc
export function offsiteFileName(localName) {
  return `${localName}${OFF_SITE_SUFFIX}`;
}

// Rejects any file that is not an offsite-encrypted copy of a FlipBlog backup.
export function parseOffsiteName(name) {
  if (!name.endsWith(OFF_SITE_SUFFIX)) return null;
  const parsed = parseBackupName(name.slice(0, -OFF_SITE_SUFFIX.length));
  if (!parsed) return null;
  return parsed;
}

// --- Key handling -----------------------------------------------------------
//
// The offsite key is a single 32-byte AES-256 key. It is accepted either as 64
// hex characters or as 44-char base64 (32 bytes). Anything else is rejected so
// a typo'd or truncated key cannot silently encrypt backups under a different,
// unusable key.
export function isValidBackupKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const hex = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return true;
  const b64 = value.trim();
  const decoded = Buffer.from(b64, 'base64');
  return decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === b64.replace(/=+$/, '');
}

export function resolveEncryptionKey(value) {
  if (!isValidBackupKey(value)) {
    throw new Error('BACKUP_OFFSITE_KEY must be a 32-byte AES key encoded as 64 hex characters or base64');
  }
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  return Buffer.from(v, 'base64');
}

export function generateEncryptionKey() {
  return randomBytes(32).toString('hex');
}

// --- Streaming encrypt / decrypt -------------------------------------------

class EncryptTransform extends Transform {
  constructor(key) {
    super();
    this.iv = randomBytes(IV_LEN);
    this.cipher = createCipheriv('aes-256-gcm', key, this.iv);
    this.headerWritten = false;
  }

  _transform(chunk, _enc, cb) {
    try {
      if (!this.headerWritten) {
        this.push(Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), this.iv]));
        this.headerWritten = true;
      }
      this.push(this.cipher.update(chunk));
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _flush(cb) {
    try {
      if (!this.headerWritten) {
        this.push(Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), this.iv]));
        this.headerWritten = true;
      }
      this.push(this.cipher.final());
      this.push(this.cipher.getAuthTag());
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

// Encrypts `srcPath` into `destPath`. Streams; the auth tag is appended last.
export async function encryptFile(srcPath, key, destPath) {
  await pipeline(createReadStream(srcPath), new EncryptTransform(key), createWriteStream(destPath));
}

// Decrypts an offsite backup. Streams the body after reading the header and the
// trailing auth tag. Throws on truncation, a bad magic/version, or an auth-tag
// mismatch (tamper / wrong key).
export async function decryptFile(srcPath, key, destPath) {
  const size = statSync(srcPath).size;
  if (size < HEADER_LEN + TAG_LEN) {
    throw new Error('offsite backup is truncated: file is smaller than the encrypted header and auth tag');
  }
  const fd = openSync(srcPath, 'r');
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_LEN);
    readSync(fd, header, 0, HEADER_LEN, 0);
    tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a FlipBlog offsite backup: bad magic header');
  }
  if (header[MAGIC.length] !== FORMAT_VERSION) {
    throw new Error(`unsupported offsite backup format version ${header[MAGIC.length]}`);
  }
  const iv = header.subarray(MAGIC.length + 1);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const body = createReadStream(srcPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 });
  try {
    await pipeline(body, decipher, createWriteStream(destPath));
  } catch (err) {
    // Never leave a partial plaintext behind on a failed restore.
    try {
      rmSync(destPath, { force: true });
    } catch {
      /* best-effort */
    }
    throw new Error(
      `offsite backup failed authentication: ${err && err.code === 'ERR_DECRYPTION_FAILED' ? 'tampered data or wrong key' : err.message}`
    );
  }
}

// --- Push + retention -------------------------------------------------------

function pruneOffsiteBackups(dir, retention, log) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => parseOffsiteName(n));
  } catch {
    return { retained: [], pruned: [] };
  }
  const parsed = names.map((name) => {
    const p = parseOffsiteName(name);
    return { name, ts: p.ts, version: p.version, suffix: p.suffix };
  });
  parsed.sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const removeCount = Math.max(0, parsed.length - retention);
  const toRemove = parsed.slice(0, removeCount);
  const pruned = [];
  for (const { name } of toRemove) {
    try {
      rmSync(join(dir, name), { force: true });
      pruned.push(name);
    } catch {
      log.warn({ event: 'offsite_backup_prune_failed', name });
    }
  }
  return { retained: parsed.slice(removeCount).map((p) => p.name), pruned };
}

// Encrypts a local backup file into `destDir` under `<name>.enc`, atomically
// (temp file + rename), then prunes old offsite copies down to `retention`.
// Returns a manifest describing what was pushed and pruned. Throws on genuine
// encryption/write failure so callers can fail loudly rather than believe an
// offsite copy exists when it does not.
export async function pushOffsiteBackup({ sourcePath, destDir, key, retention = 5, log = logger }) {
  const localName = basename(sourcePath);
  const parsed = parseBackupName(localName);
  if (!parsed) {
    throw new Error(`refusing to push non-backup file to offsite: ${localName}`);
  }
  mkdirSync(destDir, { recursive: true });
  const finalName = offsiteFileName(localName);
  const finalPath = join(destDir, finalName);
  const tmpPath = join(destDir, `.${finalName}.tmp`);
  try {
    await encryptFile(sourcePath, key, tmpPath);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort */
    }
    log.error({ event: 'offsite_backup_failed', name: finalName }, err);
    throw new Error(`offsite backup failed: ${err && err.message ? err.message : err}`);
  }
  const pruned = pruneOffsiteBackups(destDir, retention, log);
  log.info({
    event: 'offsite_backup_pushed',
    version: parsed.version,
    name: finalName,
    retained: pruned.retained.length,
  });
  return { offsitePath: finalPath, name: finalName, version: parsed.version, ts: parsed.ts, retained: pruned.retained, pruned: pruned.pruned };
}

// Lists offsite backups in `dir`, newest first. Returns [] when the dir is
// missing/unreadable. Only FlipBlog `.enc` files are considered.
export function listOffsiteBackups(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => parseOffsiteName(n));
  } catch {
    return [];
  }
  const parsed = names
    .map((name) => {
      const p = parseOffsiteName(name);
      return { name, path: join(dir, name), ts: p.ts, version: p.version };
    })
    .sort((a, b) => {
      if (a.ts < b.ts) return 1;
      if (a.ts > b.ts) return -1;
      if (a.name < b.name) return 1;
      if (a.name > b.name) return -1;
      return 0;
    });
  return parsed;
}

export function newestOffsiteBackup(dir) {
  return listOffsiteBackups(dir)[0] ?? null;
}
