import { Logger } from '@nestjs/common';

/**
 * mysql2's error shape. TypeORM wraps it in QueryFailedError.driverError and
 * copies `code`/`errno` onto the wrapper too, so both are checked (same shape
 * as http-exception.filter.ts and crud.factory.ts).
 */
interface MysqlDriverError {
  code?: string;
  errno?: number;
}

function driverErrorOf(err: unknown): MysqlDriverError | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const wrapped = (err as { driverError?: MysqlDriverError }).driverError;
  return wrapped ?? (err as MysqlDriverError);
}

/**
 * S1/BF-2: InnoDB picked this transaction as a deadlock victim (1213). It has
 * already rolled the whole transaction back, so running it again from the
 * start is safe.
 *
 * Deliberately NOT 1205 (ER_LOCK_WAIT_TIMEOUT): that one only fires after
 * innodb_lock_wait_timeout (50 s by default), so retrying it would keep the
 * request open for minutes — long after the SSR proxy gave up at 30 s — and
 * InnoDB rolls back only the statement, not the transaction.
 */
export function isDeadlock(err: unknown): boolean {
  const e = driverErrorOf(err);
  return e?.errno === 1213 || e?.code === 'ER_LOCK_DEADLOCK';
}

export function isDuplicateEntry(err: unknown): boolean {
  const e = driverErrorOf(err);
  return e?.errno === 1062 || e?.code === 'ER_DUP_ENTRY';
}

export interface TransactionRetryOptions {
  /** Total tries, the first one included. */
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  /** Names the operation in the warning; never put request data in it. */
  label?: string;
  logger?: Pick<Logger, 'warn'>;
  /** Injected by the unit tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run` — which must open its own transaction — and runs it again from
 * the start when it fails as a deadlock victim. Backoff is "full jitter":
 * random(0, min(cap, base · 2^n)), so the transactions that collided don't
 * collide again in lockstep. Anything that isn't a deadlock is rethrown at
 * once; the last deadlock is rethrown once the attempts are spent.
 *
 * Wrap only the transaction itself. Whatever follows the commit (sending
 * mail) must stay outside, or a retry could repeat it.
 */
export async function withTransactionRetry<T>(run: () => Promise<T>, options: TransactionRetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseMs = options.baseMs ?? 25;
  const capMs = options.capMs ?? 400;
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? new Logger('TransactionRetry');

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= attempts) throw err;
      const delay = Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** (attempt - 1)));
      logger.warn(
        `${options.label ?? 'transaction'}: deadlock (errno 1213), retrying (attempt ${attempt + 1}/${attempts}) in ${delay} ms`,
      );
      await sleep(delay);
    }
  }
}
