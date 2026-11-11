import { setTimeout } from 'node:timers/promises';

export interface QueueOptions {
  onError?: (queue: number, error: unknown, failures: number) => void;
  backoffMs?: (failures: number) => number;
  /** Wait after an iteration that found nothing to do; grows while a queue stays idle. */
  idleMs?: (idle: number) => number;
}
// Idle queues back off from 250 ms to 5 s, so an empty system is not polled many times a
// second; the first job after a quiet spell waits at most a few seconds.
const defaultIdle = (idle: number) => Math.min(5_000, 250 * 2 ** Math.min(idle - 1, 5));
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
  const idleWait = options.idleMs ?? defaultIdle;
  await Promise.all(
    jobs.map(async (job, queue) => {
      let failures = 0, idle = 0;
      while (active()) {
        try {
          const worked = await job();
          failures = 0;
          idle = worked ? 0 : idle + 1;
          if (!worked && active()) await setTimeout(idleWait(idle));
        } catch (error) {
          failures++;
          options.onError?.(queue, error, failures);
          if (active()) await setTimeout(backoff(failures));
        }
      }
    }),
  );
}
