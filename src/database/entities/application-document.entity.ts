import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Application } from './application.entity.js';
import { User } from './user.entity.js';

export type ApplicationDocType = 'id_copy' | 'certificate' | 'admission_letter' | 'other';
export type ApplicationDocumentStatus = 'under_review' | 'accepted' | 'rejected';

/**
 * `storage_key` points under STORAGE_ROOT/private/applications/<applicationId>/
 * (src/storage/private-file-store.service.ts) — student documents are NEVER
 * stored in media_assets, so the public /files/:publicId gate can never
 * expose them (Safeer infra change §3).
 */
@Entity('application_documents')
@Index('ix_appdocs_application', ['applicationId', 'docType', 'supersededAt'])
export class ApplicationDocument {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_appdocs_application' })
  application?: Application;

  @Column({ name: 'doc_type', type: 'enum', enum: ['id_copy', 'certificate', 'admission_letter', 'other'] as ApplicationDocType[] })
  docType: ApplicationDocType;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey: string;

  @Column({ type: 'varchar', length: 100 })
  mime: string;

  @Column({ name: 'size_bytes', type: 'int', unsigned: true })
  sizeBytes: number;

  @Column({ type: 'char', length: 64 })
  checksum: string;

  @Column({ type: 'enum', enum: ['under_review', 'accepted', 'rejected'] as ApplicationDocumentStatus[], default: 'under_review' })
  status: ApplicationDocumentStatus;

  @Column({ name: 'rejection_reason', type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ name: 'reviewed_by', type: 'bigint', unsigned: true, nullable: true })
  reviewedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'reviewed_by', foreignKeyConstraintName: 'fk_appdocs_reviewer' })
  reviewer?: User | null;

  @Column({ name: 'reviewed_at', type: 'datetime', precision: 3, nullable: true })
  reviewedAt: Date | null;

  /** set when a re-upload replaces this row's document */
  @Column({ name: 'superseded_at', type: 'datetime', precision: 3, nullable: true })
  supersededAt: Date | null;

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
