import { pool } from '../../../packages/database/src/index.js';

type Result = { current: number; ttl: number };
type RouteInfo = { routeInfo?: { method?: string; url?: string } };

/**
 * A @fastify/rate-limit store kept in PostgreSQL, so every API instance counts against
 * the same window. One atomic upsert per counted request; an expired window restarts at 1.
 * Enable with KORA_RATE_LIMIT_STORE=postgres when running more than one API instance.
 */
export class PostgresRateLimitStore {
  constructor(_options?: unknown, private readonly prefix = 'global:') {}

  incr(key: string, callback: (error: Error | null, result?: Result) => void, timeWindow: number) {
    pool.query(`INSERT INTO rate_limit_hits(key,count,window_ends) VALUES($1,1,now()+$2*interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        count=CASE WHEN rate_limit_hits.window_ends<=now() THEN 1 ELSE rate_limit_hits.count+1 END,
        window_ends=CASE WHEN rate_limit_hits.window_ends<=now() THEN now()+$2*interval '1 millisecond' ELSE rate_limit_hits.window_ends END
      RETURNING count, GREATEST(0, (extract(epoch FROM window_ends-now())*1000)::bigint) AS ttl`,
      [(this.prefix + key).slice(0, 512), timeWindow])
      .then(({ rows }) => callback(null, { current: Number(rows[0].count), ttl: Number(rows[0].ttl) }))
      .catch((error: Error) => callback(error));
  }

  /** Each route with its own limit counts separately. */
  child(routeOptions: RouteInfo) {
    return new PostgresRateLimitStore(undefined, `${routeOptions.routeInfo?.method ?? ''}${routeOptions.routeInfo?.url ?? ''}:`);
  }
}

export const sharedRateLimitStore = () => process.env.KORA_RATE_LIMIT_STORE === 'postgres';
