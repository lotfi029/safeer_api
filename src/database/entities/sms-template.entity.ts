import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity.js';

/**
 * `key` is a MySQL reserved word — TypeORM backtick-quotes generated
 * identifiers automatically, so no special handling is needed here.
 * Mirrors mail_templates, but plain text only (no Markdown/HTML) and short.
 */
@Entity('sms_templates')
@Unique('uq_sms_tpl_key', ['key'])
export class SmsTemplate {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** otp_code | application_submitted | application_status_changed | documents_requested */
  @Column({ type: 'varchar', length: 64 })
  key: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 191 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 191, nullable: true })
  nameEn: string | null;

  /** plain text with {{variables}} — no Markdown, kept short */
  @Column({ name: 'body_ar', type: 'varchar', length: 480 })
  bodyAr: string;

  @Column({ name: 'body_en', type: 'varchar', length: 480, nullable: true })
  bodyEn: string | null;

  /** the allow-list, owned by the code */
  @Column({ type: 'json' })
  variables: string[];

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean;

  @Column({ name: 'updated_by', type: 'bigint', unsigned: true, nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by', foreignKeyConstraintName: 'fk_sms_tpl_user' })
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
