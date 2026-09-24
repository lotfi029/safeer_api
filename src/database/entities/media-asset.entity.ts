import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity.js';

export type MediaAssetKind = 'image' | 'pdf';

/**
 * Every foreign key pointing at media_assets uses ON DELETE RESTRICT
 * (12-database.md §3.2) — that is what makes FR-F-04 ("a file in use cannot
 * be deleted") a guarantee rather than a check the API might forget.
 */
@Entity('media_assets')
@Unique('uq_assets_public', ['publicId'])
@Unique('uq_assets_checksum', ['checksumSha256'])
@Index('ix_assets_kind', ['kind', 'createdAt'])
export class MediaAsset {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** used in /files/:public_id */
  @Column({ name: 'public_id', type: 'char', length: 36 })
  publicId: string;

  @Column({ type: 'enum', enum: ['image', 'pdf'] as MediaAssetKind[] })
  kind: MediaAssetKind;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType: string;

  @Column({ name: 'size_bytes', type: 'int', unsigned: true })
  sizeBytes: number;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName: string;

  /** assets/2026/09/<uuid>.webp */
  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey: string;

  /** duplicate detection */
  @Column({ name: 'checksum_sha256', type: 'char', length: 64 })
  checksumSha256: string;

  @Column({ name: 'width_px', type: 'smallint', unsigned: true, nullable: true })
  widthPx: number | null;

  @Column({ name: 'height_px', type: 'smallint', unsigned: true, nullable: true })
  heightPx: number | null;

  /** required before an image may be attached */
  @Column({ name: 'alt_ar', type: 'varchar', length: 255, nullable: true })
  altAr: string | null;

  @Column({ name: 'alt_en', type: 'varchar', length: 255, nullable: true })
  altEn: string | null;

  @Column({ name: 'uploaded_by', type: 'bigint', unsigned: true, nullable: true })
  uploadedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'uploaded_by', foreignKeyConstraintName: 'fk_assets_user' })
  uploader?: User | null;

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
