import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { Locale } from '../../common/request-context.js';

export type ContactMessageSubject = 'scholarship' | 'partnership' | 'feedback' | 'other';
export type ContactMessageStatus = 'unread' | 'read' | 'archived';

@Entity('contact_messages')
@Index('ix_messages_inbox', ['status', 'createdAt'])
export class ContactMessage {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'varchar', length: 191 })
  name: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 191 })
  email: string;

  @Column({ type: 'enum', enum: ['scholarship', 'partnership', 'feedback', 'other'] as ContactMessageSubject[] })
  subject: ContactMessageSubject;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: ['unread', 'read', 'archived'] as ContactMessageStatus[], default: 'unread' })
  status: ContactMessageStatus;

  @Column({ type: 'enum', enum: ['ar', 'en'] as Locale[], default: 'ar' })
  locale: Locale;

  /** hashed, never the raw address */
  @Column({ name: 'ip_hash', type: 'char', length: 64, nullable: true })
  ipHash: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

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
