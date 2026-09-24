import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * e.g. key='application:2026', value=184. The reference SA-2026-00184 is
 * taken with `SELECT … FOR UPDATE` inside the same transaction as the
 * application insert (src/applications, phase 6).
 */
@Entity('counters')
export class Counter {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  value: number;
}
