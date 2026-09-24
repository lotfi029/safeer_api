import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DocCategory } from './doc-category.entity.js';
import { MediaAsset } from './media-asset.entity.js';

@Entity('documents')
@Index('ix_docs_register', ['categoryId', 'isPublished', 'sortOrder'])
@Index('ix_docs_date', ['categoryId', 'docDate'])
export class SafeerDocument {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'category_id', type: 'bigint', unsigned: true })
  categoryId: string;

  @ManyToOne(() => DocCategory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id', foreignKeyConstraintName: 'fk_docs_cat' })
  category?: DocCategory;

  @Column({ name: 'title_ar', type: 'varchar', length: 255 })
  titleAr: string;

  @Column({ name: 'title_en', type: 'varchar', length: 255, nullable: true })
  titleEn: string | null;

  /** NULL renders as "coming soon" */
  @Column({ name: 'asset_id', type: 'bigint', unsigned: true, nullable: true })
  assetId: string | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'asset_id', foreignKeyConstraintName: 'fk_docs_asset' })
  asset?: MediaAsset | null;

  @Column({ name: 'doc_date', type: 'date', nullable: true })
  docDate: string | null;

  @Column({ name: 'download_count', type: 'int', unsigned: true, default: 0 })
  downloadCount: number;

  @Column({ name: 'is_published', type: 'boolean', default: false })
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
