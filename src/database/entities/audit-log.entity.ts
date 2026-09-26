import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity.js';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'publish'
  | 'unpublish'
  | 'login'
  | 'login_failed'
  | 'upload'
  | 'export';

/** Append-only: the application account is granted INSERT and SELECT only — no UPDATE or DELETE. */
@Entity('audit_log')
@Index('ix_audit_recent', ['createdAt'])
@Index('ix_audit_entity', ['entityType', 'entityId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'actor_id', type: 'bigint', unsigned: true, nullable: true })
  actorId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id', foreignKeyConstraintName: 'fk_audit_user' })
  actor?: User | null;

  @Column({
    type: 'enum',
    enum: ['create', 'update', 'delete', 'publish', 'unpublish', 'login', 'login_failed', 'upload', 'export'] as AuditAction[],
  })
  action: AuditAction;

  /** library_items, meetings, users … */
  @Column({ name: 'entity_type', type: 'varchar', length: 64 })
  entityType: string;

  @Column({ name: 'entity_id', type: 'bigint', unsigned: true, nullable: true })
  entityId: string | null;

  /** human title at the time of the action */
  @Column({ name: 'entity_label', type: 'varchar', length: 255, nullable: true })
  entityLabel: string | null;

  /** {before, after} — full snapshot on delete */
  @Column({ type: 'json', nullable: true })
  diff: Record<string, unknown> | null;

  @Column({ name: 'ip_hash', type: 'char', length: 64, nullable: true })
  ipHash: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
