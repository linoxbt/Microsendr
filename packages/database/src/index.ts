import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const production = process.env.NODE_ENV === 'production';
if (process.env.KORA_MODE && process.env.KORA_MODE !== 'sandbox') throw new Error('This phase of Kora supports sandbox mode only');
// Production never falls back to the local development database or an implicit mode.
if (production && (!process.env.DATABASE_URL || process.env.KORA_MODE !== 'sandbox'))
  throw new Error('Set DATABASE_URL and KORA_MODE=sandbox in production');
export const localDatabaseUrl = 'postgres://kora:kora_local_only@127.0.0.1:55432/kora';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || localDatabaseUrl,
  max: Number(process.env.DATABASE_POOL_MAX ?? 12),
  // Fail fast instead of queueing forever when every connection is busy.
  connectionTimeoutMillis: 5000,
});
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await transactionOn(client, fn); } finally { client.release(); }
}
export async function transactionOn<T>(client: pg.PoolClient, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
export type Client = pg.PoolClient;
