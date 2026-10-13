import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** The governance register's sections (022): bylaws, financial reports, the general assembly, plans, reports, committees … */
export const DOC_SECTION_GROUPS = ['governance', 'other'] as const;
export type DocSectionGroup = (typeof DOC_SECTION_GROUPS)[number];

@Entity('doc_categories')
@Unique('uq_doccat_slug', ['slug'])
export class DocCategory {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** e.g. bylaws-policies | financial-reports | general-assembly | annual-reports */
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 191 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 191, nullable: true })
  nameEn: string | null;

  /** `governance`: listed by GET documents/sections. `other`: reachable by slug only. */
  @Column({ name: 'section_group', type: 'enum', enum: [...DOC_SECTION_GROUPS], default: 'governance' })
  sectionGroup: DocSectionGroup;

  @Column({ name: 'is_published', type: 'boolean', default: true })
  isPublished: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}
