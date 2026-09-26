import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity.js';

/** Singleton (CHECK id = 1) — 002_seed.sql inserts the row; the service does UPDATE, never INSERT. */
@Entity('site_settings')
export class SiteSettings {
  @PrimaryColumn({ type: 'bigint', unsigned: true, default: 1 })
  id: string;

  @Column({ name: 'org_name_ar', type: 'varchar', length: 191 })
  orgNameAr: string;

  @Column({ name: 'org_name_en', type: 'varchar', length: 191, nullable: true })
  orgNameEn: string | null;

  @Column({ name: 'tagline_ar', type: 'varchar', length: 255, nullable: true })
  taglineAr: string | null;

  @Column({ name: 'tagline_en', type: 'varchar', length: 255, nullable: true })
  taglineEn: string | null;

  @Column({ name: 'footer_blurb_ar', type: 'text', nullable: true })
  footerBlurbAr: string | null;

  @Column({ name: 'footer_blurb_en', type: 'text', nullable: true })
  footerBlurbEn: string | null;

  @Column({ name: 'rights_line_ar', type: 'varchar', length: 255, nullable: true })
  rightsLineAr: string | null;

  @Column({ name: 'rights_line_en', type: 'varchar', length: 255, nullable: true })
  rightsLineEn: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  email: string | null;

  @Column({ name: 'address_ar', type: 'varchar', length: 255, nullable: true })
  addressAr: string | null;

  @Column({ name: 'address_en', type: 'varchar', length: 255, nullable: true })
  addressEn: string | null;

  @Column({ name: 'facebook_url', type: 'varchar', length: 255, nullable: true })
  facebookUrl: string | null;

  @Column({ name: 'instagram_url', type: 'varchar', length: 255, nullable: true })
  instagramUrl: string | null;

  @Column({ name: 'x_url', type: 'varchar', length: 255, nullable: true })
  xUrl: string | null;

  /** Settings/social (safeer-backend-fix-prompt.md) */
  @Column({ name: 'youtube_url', type: 'varchar', length: 255, nullable: true })
  youtubeUrl: string | null;

  @Column({ name: 'linkedin_url', type: 'varchar', length: 255, nullable: true })
  linkedinUrl: string | null;

  @Column({ name: 'whatsapp_url', type: 'varchar', length: 255, nullable: true })
  whatsappUrl: string | null;

  @Column({ name: 'tiktok_url', type: 'varchar', length: 255, nullable: true })
  tiktokUrl: string | null;

  @Column({ name: 'en_enabled', type: 'boolean', default: true })
  enEnabled: boolean;

  @Column({ name: 'seo_title_ar', type: 'varchar', length: 191, nullable: true })
  seoTitleAr: string | null;

  @Column({ name: 'seo_title_en', type: 'varchar', length: 191, nullable: true })
  seoTitleEn: string | null;

  @Column({ name: 'seo_description_ar', type: 'varchar', length: 500, nullable: true })
  seoDescriptionAr: string | null;

  @Column({ name: 'seo_description_en', type: 'varchar', length: 500, nullable: true })
  seoDescriptionEn: string | null;

  @Column({ name: 'notify_email_on_status_change', type: 'boolean', default: true })
  notifyEmailOnStatusChange: boolean;

  @Column({ name: 'notify_sms_on_status_change', type: 'boolean', default: true })
  notifySmsOnStatusChange: boolean;

  @Column({ name: 'application_ref_prefix', type: 'varchar', length: 10, default: 'SA' })
  applicationRefPrefix: string;

  @Column({ name: 'updated_by', type: 'bigint', unsigned: true, nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by', foreignKeyConstraintName: 'fk_settings_user' })
  updater?: User | null;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;
}
