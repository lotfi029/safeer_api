import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** الرخص، السياسات، المحاضر، التقارير السنوية — one table, several category pages. */
@Entity('doc_categories')
@Unique('uq_doccat_slug', ['slug'])
export class DocCategory {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** licences | policies | minutes | annual_reports */
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 191 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 191, nullable: true })
  nameEn: string | null;

  @Column({ name: 'is_published', type: 'boolean', default: true })
  isPublished: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}
