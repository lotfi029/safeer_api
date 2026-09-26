import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { WorkArea } from './work-area.entity.js';

@Entity('work_area_items')
@Index('ix_workarea_items', ['workAreaId', 'sortOrder'])
export class WorkAreaItem {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'work_area_id', type: 'bigint', unsigned: true })
  workAreaId: string;

  @ManyToOne(() => WorkArea, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'work_area_id', foreignKeyConstraintName: 'fk_workitem_area' })
  workArea?: WorkArea;

  @Column({ name: 'text_ar', type: 'varchar', length: 255 })
  textAr: string;

  @Column({ name: 'text_en', type: 'varchar', length: 255, nullable: true })
  textEn: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /** B11 (safeer-backend-fr-review.md) — filters the public `/work-areas` list; the admin list/detail always show every item. */
  @Column({ name: 'is_published', type: 'boolean', default: true })
  isPublished: boolean;

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
