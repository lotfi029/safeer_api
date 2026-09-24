import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { MediaAsset } from './media-asset.entity.js';

export type MediaVariantLabel = 'thumb' | 'card' | 'full';

/** No created_at/updated_at — variants are derived artefacts that cascade with their parent. */
@Entity('media_variants')
@Unique('uq_variant', ['assetId', 'label'])
export class MediaVariant {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'asset_id', type: 'bigint', unsigned: true })
  assetId: string;

  @ManyToOne(() => MediaAsset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id', foreignKeyConstraintName: 'fk_variant_asset' })
  asset?: MediaAsset;

  /** 400 / 800 / 1600 px wide, WebP */
  @Column({ type: 'enum', enum: ['thumb', 'card', 'full'] as MediaVariantLabel[] })
  label: MediaVariantLabel;

  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey: string;

  @Column({ name: 'width_px', type: 'smallint', unsigned: true })
  widthPx: number;

  @Column({ name: 'size_bytes', type: 'int', unsigned: true })
  sizeBytes: number;
}
