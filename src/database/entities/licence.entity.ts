import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { MediaAsset } from './media-asset.entity.js';

/**
 * 022: the association's licences, shown on the governance page. At most
 * one row is primary — kept by admin-licences.controller.ts inside a
 * transaction — and the primary *published* licence's number and issuer
 * are written through to site_settings (licence_no, licence_issuer_ar/en).
 */
@Entity('licences')
@Index('ix_licences_public', ['isPublished', 'isPrimary', 'sortOrder'])
@Index('ix_licences_asset', ['assetId'])
export class Licence {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'title_ar', type: 'varchar', length: 191 })
  titleAr: string;

  @Column({ name: 'title_en', type: 'varchar', length: 191, nullable: true })
  titleEn: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  number: string | null;

  @Column({ name: 'issuer_ar', type: 'varchar', length: 190, nullable: true })
  issuerAr: string | null;

  @Column({ name: 'issuer_en', type: 'varchar', length: 190, nullable: true })
  issuerEn: string | null;

  /** YYYY-MM-DD */
  @Column({ name: 'issued_on', type: 'date', nullable: true })
  issuedOn: string | null;

  /** YYYY-MM-DD */
  @Column({ name: 'expires_on', type: 'date', nullable: true })
  expiresOn: string | null;

  /** The licence document, a PDF or an image. */
  @Column({ name: 'asset_id', type: 'bigint', unsigned: true, nullable: true })
  assetId: string | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'asset_id', foreignKeyConstraintName: 'fk_licences_asset' })
  asset?: MediaAsset | null;

  @Column({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean;

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
