import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type AboutItemKind = 'vision' | 'mission' | 'goal' | 'care_pillar' | 'scholarship_step' | 'requirement';

@Entity('about_items')
@Index('ix_about_kind', ['kind', 'isPublished', 'sortOrder'])
export class AboutItem {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({
    type: 'enum',
    enum: ['vision', 'mission', 'goal', 'care_pillar', 'scholarship_step', 'requirement'] as AboutItemKind[],
  })
  kind: AboutItemKind;

  @Column({ type: 'varchar', length: 64, nullable: true })
  icon: string | null;

  @Column({ name: 'title_ar', type: 'varchar', length: 191 })
  titleAr: string;

  @Column({ name: 'title_en', type: 'varchar', length: 191, nullable: true })
  titleEn: string | null;

  @Column({ name: 'body_ar', type: 'text', nullable: true })
  bodyAr: string | null;

  @Column({ name: 'body_en', type: 'text', nullable: true })
  bodyEn: string | null;

  @Column({ name: 'is_published', type: 'boolean', default: true })
  isPublished: boolean;

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
