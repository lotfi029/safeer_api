import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Application } from './application.entity.js';
import { User } from './user.entity.js';

/**
 * `type` is a free-form string, not a TypeScript union — see the note above
 * `application_events` in migrations/001_schema.sql for why the SQL column
 * is VARCHAR rather than an ENUM. The admin-applications module (phase 7) is
 * the sole writer and owns the actual vocabulary (SUBMITTED, DOCS_RECEIVED,
 * STATUS_CHANGED, …).
 */
@Entity('application_events')
@Index('ix_appevents_application', ['applicationId', 'createdAt'])
@Index('ix_appevents_visible', ['applicationId', 'visibleToApplicant', 'createdAt'])
export class ApplicationEvent {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_appevents_application' })
  application?: Application;

  @Column({ type: 'varchar', length: 40 })
  type: string;

  /** NULL = the applicant or the system, not staff */
  @Column({ name: 'actor_id', type: 'bigint', unsigned: true, nullable: true })
  actorId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id', foreignKeyConstraintName: 'fk_appevents_actor' })
  actor?: User | null;

  @Column({ name: 'visible_to_applicant', type: 'boolean', default: false })
  visibleToApplicant: boolean;

  @Column({ type: 'json', nullable: true })
  data: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
