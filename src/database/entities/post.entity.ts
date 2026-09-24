import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { MediaAsset } from './media-asset.entity.js';
import { NewsCategory } from './news-category.entity.js';
import { User } from './user.entity.js';

/** آخر الأخبار */
@Entity('posts')
@Unique('uq_posts_slug', ['slug'])
@Index('ix_posts_feed', ['isPublished', 'publishedOn'])
@Index('ix_posts_legacy', ['isLegacy'])
export class Post {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'varchar', length: 191 })
  slug: string;

  @Column({ name: 'title_ar', type: 'varchar', length: 191 })
  titleAr: string;

  @Column({ name: 'title_en', type: 'varchar', length: 191, nullable: true })
  titleEn: string | null;

  @Column({ name: 'excerpt_ar', type: 'text', nullable: true })
  excerptAr: string | null;

  @Column({ name: 'excerpt_en', type: 'text', nullable: true })
  excerptEn: string | null;

  /** Markdown */
  @Column({ name: 'body_ar', type: 'mediumtext', nullable: true })
  bodyAr: string | null;

  @Column({ name: 'body_en', type: 'mediumtext', nullable: true })
  bodyEn: string | null;

  @Column({ name: 'category_id', type: 'bigint', unsigned: true })
  categoryId: string;

  @ManyToOne(() => NewsCategory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id', foreignKeyConstraintName: 'fk_posts_category' })
  category?: NewsCategory;

  /** required before publishing, enforced in the application */
  @Column({ name: 'cover_asset_id', type: 'bigint', unsigned: true, nullable: true })
  coverAssetId: string | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'cover_asset_id', foreignKeyConstraintName: 'fk_posts_cover' })
  coverAsset?: MediaAsset | null;

  @Column({ name: 'published_on', type: 'date', nullable: true })
  publishedOn: string | null;

  @Column({ name: 'is_featured', type: 'boolean', default: false })
  isFeatured: boolean;

  /** flags prototype "template content" for the clean-up flow */
  @Column({ name: 'is_legacy', type: 'boolean', default: false })
  isLegacy: boolean;

  @Column({ name: 'is_published', type: 'boolean', default: false })
  isPublished: boolean;

  @Column({ name: 'created_by', type: 'bigint', unsigned: true, nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by', foreignKeyConstraintName: 'fk_posts_author' })
  author?: User | null;

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
