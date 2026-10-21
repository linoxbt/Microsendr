import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import pg from 'pg';
import { localDatabaseUrl, pool } from '../packages/database/src/index.js';
const container = process.env.KORA_POSTGRES_CONTAINER ?? 'kora-postgres';
if (!/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Invalid PostgreSQL container identifier');
const source = new URL(
  process.env.DATABASE_URL ?? localDatabaseUrl,
);
const database = decodeURIComponent(source.pathname.slice(1)),
  user = decodeURIComponent(source.username);
const restoreName = `kora_restore_${randomBytes(8).toString('hex')}`;
function command(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0,
      error = '';
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 256 * 1024 * 1024) {
        child.kill();
        reject(new Error('Backup exceeds local drill size limit'));
      } else chunks.push(b);
    });
    child.stderr.on('data', (b) => {
      error += b.toString();
    });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`PostgreSQL tool failed (${code}): ${error.slice(0, 1000)}`)),
    );
    child.stdin.end(input);
  });
}
async function manifest(c: pg.PoolClient) {
  const tables = (
    await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows;
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected table identifier');
    const rows = (
      await c.query(
        `SELECT to_jsonb(t)::text AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
    result[tablename] = {
      count: rows.length,
      sha256: createHash('sha256')
        .update(rows.map((r) => r.row + '\n').join(''))
        .digest('hex'),
    };
  }
  return result;
}
let restored: pg.Pool | undefined;
const c = await pool.connect();
try {
  await mkdir('.sandbox/backups', { recursive: true, mode: 0o700 });
  const keyPath = '.sandbox/backup-key';
  try {
    await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if ((await stat(keyPath)).mode & 0o077) throw new Error('Backup key permissions must be 0600');
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error('Invalid backup encryption key');
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  const snapshot = (await c.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;
  const expected = await manifest(c);
  const archive = await command([
    'pg_dump',
    '-U',
    user,
    '-d',
    database,
    '-Fc',
    `--snapshot=${snapshot}`,
    '--no-owner',
    '--no-acl',
  ]);
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    Buffer.from('KORA-BACKUP-1\n'),
    nonce,
    cipher.update(archive),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const path = `.sandbox/backups/${restoreName}.aesgcm`;
  await writeFile(path, encrypted, { mode: 0o600, flag: 'wx' });
  await c.query('COMMIT');
  const saved = await readFile(path),
    header = Buffer.from('KORA-BACKUP-1\n');
  if (!saved.subarray(0, header.length).equals(header)) throw new Error('Invalid archive format');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    saved.subarray(header.length, header.length + 12),
  );
  decipher.setAuthTag(saved.subarray(-16));
  const decoded = Buffer.concat([
    decipher.update(saved.subarray(header.length + 12, -16)),
    decipher.final(),
  ]);
  // A new database only: never restore over the source or run a restored worker.
  await pool.query(`CREATE DATABASE "${restoreName}"`);
  await command(
    [
      'pg_restore',
      '-U',
      user,
      '-d',
      restoreName,
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
    ],
    decoded,
  );
  const restoreUrl = new URL(source);
  restoreUrl.pathname = `/${restoreName}`;
  restored = new pg.Pool({ connectionString: restoreUrl.toString() });
  const rc = await restored.connect();
  try {
    await rc.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await rc.query("SET LOCAL TIME ZONE 'UTC'");
    const actual = await manifest(rc);
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error('Restored table counts or row checksums differ');
    await rc.query('COMMIT');
    const journal = (await rc.query('SELECT id FROM journals LIMIT 1')).rows[0];
    if (!journal) throw new Error('Restoration drill requires ledger history');
    let protectedJournal = false;
    try {
      await rc.query('UPDATE journals SET id=id WHERE id=$1', [journal.id]);
    } catch (e) {
      protectedJournal = /immutable/.test((e as Error).message);
    }
    if (!protectedJournal) throw new Error('Restored immutable journal protection failed');
    let lateEntryRejected = false;
    try {
      await rc.query(
        'INSERT INTO ledger_entries(journal_id,account_id,side,amount) SELECT journal_id,account_id,side,amount FROM ledger_entries LIMIT 1',
      );
    } catch (e) {
      lateEntryRejected = /append|posting transaction|posted|closed/i.test((e as Error).message);
    }
    if (!lateEntryRejected) throw new Error('Restored late-entry protection failed');
    const checks = (
      await rc.query(`SELECT
     NOT EXISTS(SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY e.journal_id,a.asset HAVING SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)<>0) AS balanced,
     NOT EXISTS(SELECT 1 FROM ledger_accounts a JOIN ledger_entries e ON e.account_id=a.id WHERE a.merchant_id IS NOT NULL AND a.purpose IN ('available','reserved') GROUP BY a.id HAVING SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)<0) AS nonnegative,
     NOT EXISTS(SELECT 1 FROM journals j WHERE NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.journal_id=j.id)) AS no_empty_journals`)
    ).rows[0];
    if (!Object.values(checks).every(Boolean))
      throw new Error('Restored financial invariants failed');
    const proof = {
      created_at: new Date().toISOString(),
      source_database: database,
      restore_database: restoreName,
      encrypted_archive: path,
      archive_sha256: createHash('sha256').update(saved).digest('hex'),
      tables_verified: Object.keys(expected).length,
      rows_verified: Object.values(expected).reduce((n, t) => n + t.count, 0),
      identical_rows: true,
      immutable_journals: true,
      late_entries_rejected: true,
      ledger_checks: checks,
      restored_workers_started: false,
      offsite_backup_validated: false,
    };
    await writeFile(`${path}.proof.json`, JSON.stringify(proof, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(JSON.stringify(proof, null, 2));
  } finally {
    rc.release();
  }
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  c.release();
  await restored?.end();
  await pool.end();
}
