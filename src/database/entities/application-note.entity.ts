import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Application } from './application.entity.js';
import { User } from './user.entity.js';

/** Internal only — never visible_to_applicant. */
@Entity('application_notes')
@Index('ix_appnotes_application', ['applicationId', 'createdAt'])
export class ApplicationNote {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_appnotes_application' })
  application?: Application;

  @Column({ name: 'author_id', type: 'bigint', unsigned: true, nullable: true })
  authorId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'fk_appnotes_author' })
  author?: User | null;

  @Column({ type: 'text' })
  body: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
