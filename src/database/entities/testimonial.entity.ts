import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ContactMessage } from './contact-message.entity.js';

export type TestimonialStatus = 'pending' | 'published' | 'hidden';
export type TestimonialSource = 'manual' | 'contact_form';

/** Not linked to testimonial_themes — the project plan lists no such FK. */
@Entity('testimonials')
@Index('ix_testimonials_status', ['status', 'isFeatured', 'sortOrder'])
export class Testimonial {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'quote_ar', type: 'text' })
  quoteAr: string;

  @Column({ name: 'quote_en', type: 'text', nullable: true })
  quoteEn: string | null;

  @Column({ name: 'author_name', type: 'varchar', length: 191 })
  authorName: string;

  @Column({ name: 'author_desc_ar', type: 'varchar', length: 255, nullable: true })
  authorDescAr: string | null;

  @Column({ name: 'author_desc_en', type: 'varchar', length: 255, nullable: true })
  authorDescEn: string | null;

  @Column({ type: 'enum', enum: ['pending', 'published', 'hidden'] as TestimonialStatus[], default: 'pending' })
  status: TestimonialStatus;

  @Column({ name: 'is_featured', type: 'boolean', default: false })
  isFeatured: boolean;

  @Column({ type: 'enum', enum: ['manual', 'contact_form'] as TestimonialSource[], default: 'manual' })
  source: TestimonialSource;

  @Column({ name: 'source_message_id', type: 'bigint', unsigned: true, nullable: true })
  sourceMessageId: string | null;

  @ManyToOne(() => ContactMessage, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'source_message_id', foreignKeyConstraintName: 'fk_testimonial_message' })
  sourceMessage?: ContactMessage | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

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
