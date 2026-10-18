import { runQueues } from './queues.js';
import { pool } from '../../../packages/database/src/index.js';
import { runRailOnce } from '../../../packages/rails/src/index.js';
import { runOnce } from './worker.js';
import { deliverOne } from '../../../packages/payments/src/webhooks.js';
import { reconcileOneChainSettlement } from '../../../packages/settlement/src/service.js';
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
  console.log('Kora sandbox worker ready');
  const dispatch = () => runOnce({ onlyIntent });
  const rail = () => (onlyIntent ? Promise.resolve(false) : runRailOnce());
  const webhooks = () => deliverOne({ onlyMerchant });
  if (args.includes('--once')) {
    await dispatch();
    await rail();
    await webhooks();
    await reconcileOneChainSettlement();
  } else {
    await runQueues(
      [dispatch, rail, webhooks, reconcileOneChainSettlement],
      () => running,
      () => {
        running = false;
      },
    );
  }
} catch (error) {
  console.error('Kora worker stopped:', error instanceof Error ? error.name : 'Error');
  process.exitCode = 1;
} finally {
  await pool.end();
}
