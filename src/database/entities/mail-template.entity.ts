import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity.js';

/**
 * `key` is a MySQL reserved word (trap 14) — TypeORM backtick-quotes every
 * identifier it generates automatically, so no special handling is needed
 * here beyond the column name itself.
 */
@Entity('mail_templates')
@Unique('uq_tpl_key', ['key'])
export class MailTemplate {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** contact_ack | contact_notify | user_invite | password_reset | donation_receipt */
  @Column({ type: 'varchar', length: 64 })
  key: string;

  /** what an editor sees in the list */
  @Column({ name: 'name_ar', type: 'varchar', length: 191 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 191, nullable: true })
  nameEn: string | null;

  @Column({ name: 'subject_ar', type: 'varchar', length: 255 })
  subjectAr: string;

  @Column({ name: 'subject_en', type: 'varchar', length: 255, nullable: true })
  subjectEn: string | null;

  /** Markdown with {{variables}} */
  @Column({ name: 'body_ar', type: 'mediumtext' })
  bodyAr: string;

  @Column({ name: 'body_en', type: 'mediumtext', nullable: true })
  bodyEn: string | null;

  /** ["name","link"] — the allow-list, owned by the code */
  @Column({ type: 'json' })
  variables: string[];

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean;

  @Column({ name: 'updated_by', type: 'bigint', unsigned: true, nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by', foreignKeyConstraintName: 'fk_tpl_user' })
  updater?: User | null;

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
