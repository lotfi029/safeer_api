import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** أرقام وإحصائيات — value stays NULL until verified, rendered as "—". */
@Entity('stats')
@Index('ix_stats_order', ['isPublished', 'sortOrder'])
export class Stat {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'bigint', nullable: true })
  value: string | null;

  @Column({ name: 'label_ar', type: 'varchar', length: 120 })
  labelAr: string;

  @Column({ name: 'label_en', type: 'varchar', length: 120, nullable: true })
  labelEn: string | null;

  @Column({ name: 'sub_ar', type: 'varchar', length: 191, nullable: true })
  subAr: string | null;

  @Column({ name: 'sub_en', type: 'varchar', length: 191, nullable: true })
  subEn: string | null;

  @Column({ name: 'is_published', type: 'boolean', default: true })
  isPublished: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;
}
