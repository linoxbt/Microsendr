import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cleanupExpired } from './cleanup.js';
import { runQueues } from './queues.js';
import { pool } from '../../../packages/database/src/index.js';
import { runRailOnce } from '../../../packages/rails/src/index.js';
import { runOnce } from './worker.js';
import { deliverOne } from '../../../packages/payments/src/webhooks.js';
import { reconcileOneChainSettlement } from '../../../packages/settlement/src/service.js';
import { indexOneIncomingWallet } from '../../../packages/settlement/src/incoming.js';
import { reconcileOneConversionOrder } from '../../api/src/conversion.js';
import { reconcileOneDiditSession } from '../../api/src/didit.js';
import { reconcileOnePersonalPaystack } from '../../api/src/personal-paystack.js';
import { legacyPlatformEnabled, sandboxFixturesEnabled } from '../../api/src/config.js';
let running = true;
const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const onlyIntent = value('--intent'),
  onlyMerchant = value('--merchant');
for (const candidate of [onlyIntent, onlyMerchant])
  if (candidate && !/^[a-z]+_[a-f0-9]{32}$/.test(candidate))
    throw new Error('Invalid worker filter');
process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});
try {
  await pool.query('SELECT 1');
  console.log('Microsendr worker ready');
  const dispatch = () => runOnce({ onlyIntent });
  const rail = () => (onlyIntent ? Promise.resolve(false) : runRailOnce());
  const webhooks = () => deliverOne({ onlyMerchant });
  if (args.includes('--once')) {
    await dispatch();
    await rail();
    await webhooks();
    await reconcileOneChainSettlement();
    await reconcileOneDiditSession();
    await reconcileOnePersonalPaystack();
    await indexOneIncomingWallet();
    await reconcileOneConversionOrder();
    await cleanupExpired(true);
  } else {
    // Microsendr jobs always run; the retired business platform and the Paystack sandbox only where enabled.
    const queues: Record<string, () => Promise<boolean>> = {
      chain: reconcileOneChainSettlement, kyc: () => reconcileOneDiditSession(),
      incoming: () => indexOneIncomingWallet(), conversion: () => reconcileOneConversionOrder(), cleanup: () => cleanupExpired(),
      ...(legacyPlatformEnabled() ? { dispatch, rail, webhooks } : {}),
      ...(sandboxFixturesEnabled() ? { paystack: () => reconcileOnePersonalPaystack() } : {}),
    };
    const names = Object.keys(queues);
    // A heartbeat file, touched as queue iterations complete, backs the container healthcheck.
    let beat = 0;
    const heartbeat = <T>(job: () => Promise<T>) => async () => {
      const result = await job();
      if (Date.now() - beat > 10_000) {
        beat = Date.now();
        await writeFile(process.env.KORA_WORKER_HEARTBEAT ?? '/tmp/worker-heartbeat', String(beat)).catch(() => undefined);
      }
      return result;
    };
    // Optional HTTP probe on its own port (never PORT, which the API may use in the same host).
    const port = Number(process.env.KORA_WORKER_HEALTH_PORT);
    const health = port ? createServer((request, response) => {
      const fresh = Date.now() - beat < 120_000;
      response.writeHead(request.url === '/health' ? (fresh ? 200 : 503) : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(request.url === '/health' ? JSON.stringify({ status: fresh ? 'ok' : 'stalled', service: 'microsendr-worker' }) : '{}');
    }).on('error', (error) => console.error(JSON.stringify({ level: 'error', msg: 'worker health server failed', error: error.message })))
      .listen(port, process.env.HOST ?? '0.0.0.0') : undefined;
    // Watchdog: if no queue has completed an iteration for five minutes (database gone,
    // a hung call), exit so the platform's restart policy starts a fresh worker.
    beat = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - beat < 5 * 60_000) return;
      console.error(JSON.stringify({ level: 'fatal', msg: 'worker stalled; exiting for restart', last_beat: new Date(beat).toISOString() }));
      process.exit(1);
    }, 30_000);
    watchdog.unref();
    await runQueues(Object.values(queues).map(heartbeat), () => running, {
      onError: (queue, error, failures) =>
        console.error(JSON.stringify({
          level: 'error', msg: 'worker queue iteration failed', queue: names[queue], failures,
          error: error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: string }).code } : String(error),
        })),
    });
    clearInterval(watchdog);
    health?.close();
  }
} catch (error) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'worker stopped', error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
