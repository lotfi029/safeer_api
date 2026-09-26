import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

/** How long a shutdown waits for work still in flight (ecosystem.config.cjs kill_timeout is a little longer). */
const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * A4 (safeer-delivery-review.md): work a public route starts but must not
 * wait for — the route answers first, so its response time can't tell a
 * caller whether an identifier matched anything.
 *
 * - `run()` starts the task on the next turn of the event loop, never in the
 *   caller's own tick, and logs a failure instead of throwing it (the label
 *   and the error only — tasks must not put secrets in their errors).
 * - Tasks sharing a `key` run one after another, in the order `run()` was
 *   called: two OTP requests for one application can't interleave their
 *   insert and their send, so the last code delivered is the live one.
 * - `settled()` resolves once nothing is in flight, including tasks started
 *   by other tasks. The dev/test hooks use it (DevOtpController).
 * - On shutdown (`app.enableShutdownHooks()` in main.ts) the process waits
 *   up to SHUTDOWN_DRAIN_MS for work in flight. This runs in
 *   `beforeApplicationShutdown`, before Nest closes the HTTP server and
 *   before TypeORM closes its pool in `onApplicationShutdown`, so a send in
 *   progress can still write its log row.
 */
@Injectable()
export class BackgroundWork implements BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundWork.name);
  private readonly inFlight = new Set<Promise<void>>();
  private readonly tails = new Map<string, Promise<void>>();

  run(label: string, task: () => Promise<void>, key?: string): void {
    const previous = key === undefined ? undefined : this.tails.get(key);
    const started = previous ?? new Promise<void>((resolve) => setImmediate(resolve));
    const done = started
      .then(task)
      .catch((err: unknown) => this.logger.error(`${label} failed`, err instanceof Error ? err.stack : String(err)));

    this.inFlight.add(done);
    if (key !== undefined) this.tails.set(key, done);
    void done.finally(() => {
      this.inFlight.delete(done);
      if (key !== undefined && this.tails.get(key) === done) this.tails.delete(key);
    });
  }

  /** Resolves once no task is running or queued — tasks a task starts included. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.inFlight.size === 0) return;
    this.logger.log(`Waiting for ${this.inFlight.size} background task(s) before shutdown`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_DRAIN_MS);
    });
    const outcome = await Promise.race([this.settled().then(() => 'settled' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn(`${this.inFlight.size} background task(s) still running after ${SHUTDOWN_DRAIN_MS} ms — shutting down anyway`);
    }
  }
}
