// S1/BF-2: POST applications retries a deadlock victim's transaction; C1:
// the counter mint no longer swallows a deadlock.
import 'reflect-metadata';
import { QueryFailedError } from 'typeorm';
import { isDeadlock, withTransactionRetry } from '../../src/database/transaction-retry';
import { lockCounter } from '../../src/applications/reference-counter';

function mysqlError(errno: number, code: string): QueryFailedError {
  const driverError = Object.assign(new Error(code), { errno, code });
  return new QueryFailedError('SELECT 1', [], driverError);
}

const deadlock = () => mysqlError(1213, 'ER_LOCK_DEADLOCK');
const noSleep = async () => undefined;
const quiet = { warn: jest.fn() };

describe('withTransactionRetry (S1)', () => {
  it('runs the transaction again after a deadlock and returns its result', async () => {
    const run = jest.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockResolvedValue('ok');
    await expect(withTransactionRetry(run, { sleep: noSleep, logger: quiet })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('recognises the deadlock by errno or by code, wrapped or bare', () => {
    expect(isDeadlock(deadlock())).toBe(true);
    expect(isDeadlock({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    expect(isDeadlock({ errno: 1213 })).toBe(true);
  });

  it.each([
    ['a lock-wait timeout (1205)', () => mysqlError(1205, 'ER_LOCK_WAIT_TIMEOUT')],
    ['a duplicate key (1062)', () => mysqlError(1062, 'ER_DUP_ENTRY')],
    ['a plain Error', () => new Error('boom')],
    ['an HTTP error', () => Object.assign(new Error('Conflict'), { status: 409 })],
  ])('does not retry %s', async (_name, make) => {
    const err = make();
    const run = jest.fn().mockRejectedValue(err);
    await expect(withTransactionRetry(run, { sleep: noSleep, logger: quiet })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives up after 5 attempts and rethrows the last deadlock', async () => {
    const errors = Array.from({ length: 5 }, deadlock);
    const run = jest.fn();
    for (const e of errors) run.mockRejectedValueOnce(e);
    await expect(withTransactionRetry(run, { sleep: noSleep, logger: quiet })).rejects.toBe(errors[4]);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('waits a jittered, capped delay between attempts', async () => {
    const delays: number[] = [];
    const run = jest.fn();
    for (let i = 0; i < 4; i++) run.mockRejectedValueOnce(deadlock());
    run.mockResolvedValue('ok');
    await withTransactionRetry(run, { sleep: async (ms) => void delays.push(ms), logger: quiet, baseMs: 25, capMs: 400 });
    expect(delays).toHaveLength(4);
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(Math.min(400, 25 * 2 ** i));
    });
  });
});

describe('lockCounter (C1)', () => {
  function stubManager(saveError: unknown, rereadValue: unknown = { key: 'application:2026', value: 7 }) {
    const getOne = jest.fn().mockResolvedValueOnce(null).mockResolvedValue(rereadValue);
    const qb = { setLock: () => qb, where: () => qb, getOne };
    return {
      manager: {
        createQueryBuilder: () => qb,
        create: (_entity: unknown, values: unknown) => values,
        save: jest.fn().mockRejectedValue(saveError),
      } as any,
      getOne,
    };
  }

  it('rethrows a deadlock from the first-use insert instead of carrying on outside the transaction', async () => {
    const err = deadlock();
    const { manager, getOne } = stubManager(err);
    await expect(lockCounter(manager, 'application:2026')).rejects.toBe(err);
    expect(getOne).toHaveBeenCalledTimes(1);
  });

  it('re-reads the row when a concurrent request created it first (duplicate key)', async () => {
    const { manager, getOne } = stubManager(mysqlError(1062, 'ER_DUP_ENTRY'));
    await expect(lockCounter(manager, 'application:2026')).resolves.toEqual({ key: 'application:2026', value: 7 });
    expect(getOne).toHaveBeenCalledTimes(2);
  });
});
