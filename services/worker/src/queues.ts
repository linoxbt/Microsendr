import { setTimeout } from 'node:timers/promises';

export interface QueueOptions {
  onError?: (queue: number, error: unknown, failures: number) => void;
  backoffMs?: (failures: number) => number;
}
const defaultBackoff = (failures: number) => Math.min(30_000, 500 * 2 ** Math.min(failures, 6));

// Independent loops keep slow webhook IO from blocking payment/status recovery.
// A failing iteration is reported and retried with backoff; it never stops the
// other queues. On shutdown, in-flight tasks finish before the pool closes.
export async function runQueues(
  jobs: (() => Promise<boolean>)[],
  active: () => boolean,
  options: QueueOptions = {},
) {
  const backoff = options.backoffMs ?? defaultBackoff;
  await Promise.all(
    jobs.map(async (job, queue) => {
      let failures = 0;
      while (active()) {
        try {
          const worked = await job();
          failures = 0;
          if (!worked && active()) await setTimeout(250);
        } catch (error) {
          failures++;
          options.onError?.(queue, error, failures);
          if (active()) await setTimeout(backoff(failures));
        }
      }
    }),
  );
}
