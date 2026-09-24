import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { Locale } from '../../common/request-context.js';

@Entity('newsletter_subscribers')
@Unique('uq_newsletter_email', ['email'])
@Index('ix_newsletter_active', ['unsubscribedAt'])
export class NewsletterSubscriber {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'varchar', length: 191 })
  email: string;

  @Column({ type: 'enum', enum: ['ar', 'en'] as Locale[], default: 'ar' })
  locale: Locale;

  @Column({ name: 'ip_hash', type: 'char', length: 64, nullable: true })
  ipHash: string | null;

  @Column({ name: 'unsubscribed_at', type: 'datetime', precision: 3, nullable: true })
  unsubscribedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
