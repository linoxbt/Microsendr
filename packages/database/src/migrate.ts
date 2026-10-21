import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pool, transaction } from './index.js';
const directory = new URL('../migrations/', import.meta.url);
const files = (await readdir(directory)).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
await transaction(async c => {
  await c.query('SELECT pg_advisory_xact_lock(742091)');
  await c.query('CREATE TABLE IF NOT EXISTS migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await c.query('ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum text');
  for (const file of files) {
    const version = file.split('_')[0];
    const sql = await readFile(new URL(file, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = (await c.query('SELECT checksum FROM migrations WHERE version=$1', [version])).rows[0];
    if (!applied) {
      await c.query(sql);
      await c.query('INSERT INTO migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    } else if (applied.checksum === null) {
      // Databases migrated before checksums were recorded adopt the current file.
      await c.query('UPDATE migrations SET checksum=$2 WHERE version=$1', [version, checksum]);
    } else if (applied.checksum !== checksum) {
      // An applied migration must never be edited; add a new one instead.
      throw new Error(`Migration ${file} changed after it was applied`);
    }
  }
});
console.log('Kora database ready');
await pool.end();
