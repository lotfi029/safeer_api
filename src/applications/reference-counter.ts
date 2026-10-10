import type { EntityManager } from 'typeorm';
import { Counter } from '../database/entities/counter.entity.js';
import { isDuplicateEntry } from '../database/transaction-retry.js';

/**
 * Locks (`SELECT … FOR UPDATE`) the counter row for `key`, creating it at 0
 * on first use. Must run inside the caller's transaction.
 *
 * First use of a key: insert-then-lock rather than lock-then-insert. A plain
 * INSERT takes its own exclusive lock on the new row, so a concurrent
 * request racing to create the same counter fails on the primary key instead
 * of both proceeding from 0; that loser re-reads the row, now present, under
 * the lock.
 *
 * C1 (VPS deploy plan): only the duplicate-key error is that race. Anything
 * else — above all a deadlock, after which InnoDB has already rolled the
 * whole transaction back — is rethrown. Swallowing it would carry on outside
 * the transaction in autocommit mode, writing the rest non-atomically, and
 * hide the deadlock from withTransactionRetry.
 */
export async function lockCounter(manager: EntityManager, key: string): Promise<Counter> {
  const read = () =>
    manager.createQueryBuilder(Counter, 'c').setLock('pessimistic_write').where('c.key = :key', { key }).getOne();

  let counter = await read();
  if (!counter) {
    try {
      counter = await manager.save(manager.create(Counter, { key, value: 0 }));
    } catch (err) {
      if (!isDuplicateEntry(err)) throw err;
      counter = await read();
    }
  }
  if (!counter) {
    throw new Error(`Failed to mint or read the ${key} counter`);
  }
  return counter;
}
