import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OrgTone = 'auto' | 'neutral' | 'sky' | 'green' | 'brand';
export const ORG_TONES: OrgTone[] = ['auto', 'neutral', 'sky', 'green', 'brand'];

/**
 * 023: one box of the organisational structure (ported from ta3lom's job
 * titles). `parentId` is the position this one reports to — the chart line;
 * the tree is kept acyclic and at most ORG_MAX_DEPTH deep by
 * org-chart/tree-guard.ts on every write. Board and executive members point
 * here through `board_members.org_position_id`.
 */
@Entity('org_positions')
@Index('ix_org_positions_tree', ['parentId', 'sortOrder'])
export class OrgPosition {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 190 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 190, nullable: true })
  nameEn: string | null;

  @Column({ name: 'parent_id', type: 'bigint', unsigned: true, nullable: true })
  parentId: string | null;

  @ManyToOne(() => OrgPosition, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'parent_id', foreignKeyConstraintName: 'fk_org_positions_parent' })
  parent?: OrgPosition | null;

  /** `auto` resolves by depth on the public chart (neutral, sky, green, then brand). */
  @Column({ type: 'enum', enum: ORG_TONES, default: 'auto' })
  tone: OrgTone;

  /** Show the names of the published members holding this position. */
  @Column({ name: 'show_holders', type: 'boolean', default: true })
  showHolders: boolean;

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
