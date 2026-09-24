import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { Page } from './page.entity.js';
import { MediaAsset } from './media-asset.entity.js';

@Entity('page_sections')
@Unique('uq_page_section_key', ['pageId', 'sectionKey'])
@Index('ix_sections_page', ['pageId', 'isPublished', 'sortOrder'])
export class PageSection {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'page_id', type: 'bigint', unsigned: true })
  pageId: string;

  @ManyToOne(() => Page, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'page_id', foreignKeyConstraintName: 'fk_sections_page' })
  page?: Page;

  @Column({ name: 'section_key', type: 'varchar', length: 64 })
  sectionKey: string;

  @Column({ name: 'label_ar', type: 'varchar', length: 191, nullable: true })
  labelAr: string | null;

  @Column({ name: 'label_en', type: 'varchar', length: 191, nullable: true })
  labelEn: string | null;

  @Column({ name: 'heading_ar', type: 'varchar', length: 255, nullable: true })
  headingAr: string | null;

  @Column({ name: 'heading_en', type: 'varchar', length: 255, nullable: true })
  headingEn: string | null;

  @Column({ name: 'body_ar', type: 'text', nullable: true })
  bodyAr: string | null;

  @Column({ name: 'body_en', type: 'text', nullable: true })
  bodyEn: string | null;

  @Column({ name: 'primary_button_label_ar', type: 'varchar', length: 120, nullable: true })
  primaryButtonLabelAr: string | null;

  @Column({ name: 'primary_button_label_en', type: 'varchar', length: 120, nullable: true })
  primaryButtonLabelEn: string | null;

  @Column({ name: 'primary_button_url', type: 'varchar', length: 255, nullable: true })
  primaryButtonUrl: string | null;

  @Column({ name: 'secondary_button_label_ar', type: 'varchar', length: 120, nullable: true })
  secondaryButtonLabelAr: string | null;

  @Column({ name: 'secondary_button_label_en', type: 'varchar', length: 120, nullable: true })
  secondaryButtonLabelEn: string | null;

  @Column({ name: 'secondary_button_url', type: 'varchar', length: 255, nullable: true })
  secondaryButtonUrl: string | null;

  @Column({ name: 'image_asset_id', type: 'bigint', unsigned: true, nullable: true })
  imageAssetId: string | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'image_asset_id', foreignKeyConstraintName: 'fk_sections_image' })
  imageAsset?: MediaAsset | null;

  /** "visible" in the section editor */
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
