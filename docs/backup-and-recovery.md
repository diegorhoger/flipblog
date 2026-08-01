# Backup and Recovery

FlipBlog has two complementary backup layers. Do not confuse them.

| Layer | Purpose | Location | Encryption |
|-------|---------|----------|------------|
| Startup (local) backup | Rollback safety net for migrations | `<dir of DB_PATH>/backups/` (same disk) | none |
| **Offsite backup** | Disaster recovery, independent of the application disk | `BACKUP_OFFSITE_DIR` | AES-256-GCM |

The startup backup protects you from a failed deploy. It lives on the same disk as the database, so
losing the disk loses both. The offsite backup is an **encrypted copy pushed to a destination
independent of the application disk** — a mounted volume, a network share, or an object-storage
mount. It is what lets you recover a clean environment from scratch.

## How offsite backups work

The offsite push takes the newest local backup file
(`flipblog-pre-v<version>-<timestamp>-<attempt-id>.db`) and writes an AES-256-GCM-encrypted copy to
`BACKUP_OFFSITE_DIR` as `<name>.db.enc`. Each encrypted file carries its own random IV and a 16-byte
authentication tag, so every copy is independently authenticated — a tampered, truncated, or
partial backup is **rejected on restore**, never silently accepted.

The original backup name is preserved (with a `.enc` suffix), so the version and timestamp are
recoverable from the filename, and retention on the offsite directory keeps only the newest
`BACKUP_OFFSITE_RETENTION` copies.

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `BACKUP_OFFSITE_ENABLED` | unset (off) | set `true` to enable offsite pushes |
| `BACKUP_OFFSITE_DIR` | unset | destination directory, **independent of the app disk** |
| `BACKUP_OFFSITE_KEY` | unset | 32-byte AES key as **64 hex chars or base64** |
| `BACKUP_OFFSITE_RETENTION` | `5` | how many offsite copies to keep |

In production, enabling offsite backups without a destination directory or a valid key refuses to
start (fail-closed). Generate a key with:

```bash
node -e "const{randomBytes}=require('node:crypto');console.log(randomBytes(32).toString('hex'))"
```

Store `BACKUP_OFFSITE_KEY` in your secret manager, never in the repository.

### Pushing an offsite backup

```bash
# from server/
node scripts/offsite-backup.js
```

This pushes the newest local backup. To push a specific file:

```bash
BACKUP_SOURCE=/path/to/flipblog-pre-v6-...-attempt.db node scripts/offsite-backup.js
```

If no local backup exists yet, run the server once with pending migrations (it creates one), or
point `BACKUP_SOURCE` at a file you already have. A `cron`/systemd timer entry that runs this script
is the recommended way to keep offsite copies fresh. The script prints a JSON manifest and exits
non-zero on failure.

## Restore drill

`node scripts/restore-drill.js` restores the newest offsite backup into a **clean environment** and
proves it works end-to-end:

1. **Restore** — decrypts `.enc` (or copies a plain `.db`) into a fresh temp directory.
2. **Integrity / foreign keys / migrations** — verifies the restored database directly, then boots
   a real server against it and waits for `GET /api/health/ready` to return `200` (which re-applies
   any pending migrations and gates on integrity + foreign keys + migration version).
3. **Login smoke** — `POST /api/auth/login` with the configured admin credentials must succeed.
4. **Reader smoke** — `GET /api/posts` must return the restored published posts.
5. **RTO / RPO** — records **Recovery Time Objective** (elapsed milliseconds to ready) and
   **Recovery Point Objective** (age of the backup in seconds) in the report.

The report is printed as JSON. Exit code `0` means every check passed; non-zero means something
failed and `error` describes it. To restore a specific file instead of the newest:

```bash
RESTORE_SOURCE=/path/to/backup.db.enc node scripts/restore-drill.js
```

To keep the restored database on disk for inspection instead of deleting the temp workdir:

```bash
RESTORE_WORK_DIR=/tmp/restored node scripts/restore-drill.js
```

Run the drill at least once before trusting a backup, and again after any schema change.

## Restore failure and partial-backup scenarios

These are all **expected to fail** and are what the drill verifies:

- **Truncated file** — smaller than the encrypted header + tag → rejected with `truncated`.
- **Bad magic header** — not a FlipBlog offsite backup → rejected.
- **Wrong key** — GCM authentication fails → rejected; no plaintext is ever written.
- **Tampered ciphertext** — a flipped byte fails authentication → rejected; no plaintext is written.
- **Corrupt database** — the decrypted file is not a valid database → `verifyRestoredDatabase`
  reports `ok: false` and the drill fails.
- **Missing key** — restoring an `.enc` without `BACKUP_OFFSITE_KEY` → rejected.

A failed restore never leaves a partial plaintext file behind: decryption cleans up its output on
any failure.

## Access, retention, encryption, and ownership

| Concern | Guidance |
|---------|----------|
| Access | `BACKUP_OFFSITE_DIR` should be readable/writable only by the service account (e.g. `chmod 700`, mount `noexec`). Never world-readable. |
| Encryption | Every file is AES-256-GCM with a per-file random IV and authentication tag. The key is `BACKUP_OFFSITE_KEY`, held in a secret manager. |
| Ownership | Backups are owned by the process/service account that runs `scripts/offsite-backup.js`; give that account exclusive access to the destination. |
| Retention | `BACKUP_OFFSITE_RETENTION` (default 5) prunes the oldest offsite copies by actual timestamp, across mixed schema versions. |
| RPO/RTO | Recorded by the restore drill after every run; use them to size your backup schedule and alerting. |

## Production launch checklist additions

- [ ] `BACKUP_OFFSITE_DIR` is on storage independent of the application disk.
- [ ] `BACKUP_OFFSITE_KEY` is a 32-byte key stored in a secret manager (not the repo).
- [ ] `scripts/offsite-backup.js` runs on a schedule (cron/systemd timer).
- [ ] The restore drill has been run at least once and its report saved.
