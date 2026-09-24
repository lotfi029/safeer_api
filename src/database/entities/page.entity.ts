import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('pages')
@Unique('uq_pages_slug', ['slug'])
@Index('ix_pages_published', ['isPublished'])
export class Page {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'varchar', length: 191 })
  slug: string;

  @Column({ name: 'title_ar', type: 'varchar', length: 191 })
  titleAr: string;

  @Column({ name: 'title_en', type: 'varchar', length: 191, nullable: true })
  titleEn: string | null;

  @Column({ name: 'meta_title_ar', type: 'varchar', length: 191, nullable: true })
  metaTitleAr: string | null;

  @Column({ name: 'meta_title_en', type: 'varchar', length: 191, nullable: true })
  metaTitleEn: string | null;

  @Column({ name: 'meta_description_ar', type: 'varchar', length: 500, nullable: true })
  metaDescriptionAr: string | null;

  @Column({ name: 'meta_description_en', type: 'varchar', length: 500, nullable: true })
  metaDescriptionEn: string | null;

  @Column({ name: 'is_published', type: 'boolean', default: true })
  isPublished: boolean;

  /** surfaced as a content alert on admin/overview */
  @Column({ name: 'needs_review', type: 'boolean', default: false })
  needsReview: boolean;

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
