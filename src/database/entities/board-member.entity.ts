import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { MediaAsset } from './media-asset.entity.js';

export type BoardMemberGroup = 'board' | 'executive';

@Entity('board_members')
@Index('ix_board_group', ['grp', 'isPublished', 'sortOrder'])
export class BoardMember {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 191 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 191, nullable: true })
  nameEn: string | null;

  @Column({ name: 'role_ar', type: 'varchar', length: 120 })
  roleAr: string;

  @Column({ name: 'role_en', type: 'varchar', length: 120, nullable: true })
  roleEn: string | null;

  /** `group` is a reserved word */
  @Column({ type: 'enum', enum: ['board', 'executive'] as BoardMemberGroup[] })
  grp: BoardMemberGroup;

  @Column({ name: 'is_lead', type: 'boolean', default: false })
  isLead: boolean;

  @Column({ name: 'photo_asset_id', type: 'bigint', unsigned: true, nullable: true })
  photoAssetId: string | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'photo_asset_id', foreignKeyConstraintName: 'fk_board_photo' })
  photoAsset?: MediaAsset | null;

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
