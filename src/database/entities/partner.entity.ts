import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { MediaAsset } from './media-asset.entity.js';

export type PartnerCategory = 'government' | 'university' | 'association' | 'supporter';
export const PARTNER_CATEGORIES: PartnerCategory[] = ['government', 'university', 'association', 'supporter'];

/** شركاء النجاح */
@Entity('partners')
@Index('ix_partners_category', ['category', 'isPublished', 'sortOrder'])
export class Partner {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 191 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 191, nullable: true })
  nameEn: string | null;

  @Column({ type: 'enum', enum: PARTNER_CATEGORIES })
  category: PartnerCategory;

  @Column({ type: 'varchar', length: 255, nullable: true })
  url: string | null;

  @Column({ name: 'logo_asset_id', type: 'bigint', unsigned: true, nullable: true })
  logoAssetId: string | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'logo_asset_id', foreignKeyConstraintName: 'fk_partners_logo' })
  logoAsset?: MediaAsset | null;

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
