import { writeFile } from 'node:fs/promises';
import { runQueues } from './queues.js';
import { pool } from '../../../packages/database/src/index.js';
import { runRailOnce } from '../../../packages/rails/src/index.js';
import { runOnce } from './worker.js';
import { deliverOne } from '../../../packages/payments/src/webhooks.js';
import { reconcileOneChainSettlement } from '../../../packages/settlement/src/service.js';
import { reconcileOneDiditSession } from '../../api/src/didit.js';
import { reconcileOnePersonalPaystack } from '../../api/src/personal-paystack.js';
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
  } else {
    const queues = { dispatch, rail, webhooks, chain: reconcileOneChainSettlement, kyc: () => reconcileOneDiditSession(), paystack: () => reconcileOnePersonalPaystack() };
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
    await runQueues(Object.values(queues).map(heartbeat), () => running, {
      onError: (queue, error, failures) =>
        console.error(JSON.stringify({
          level: 'error', msg: 'worker queue iteration failed', queue: names[queue], failures,
          error: error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: string }).code } : String(error),
        })),
    });
  }
} catch (error) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'worker stopped', error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
