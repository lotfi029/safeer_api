import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Legacy WordPress URLs (FR-G-08). */
@Entity('redirects')
@Unique('uq_redirect_from', ['fromPath'])
export class Redirect {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** /?p=7497 */
  @Column({ name: 'from_path', type: 'varchar', length: 255 })
  fromPath: string;

  /** /ar/governance/assembly-members */
  @Column({ name: 'to_path', type: 'varchar', length: 255 })
  toPath: string;

  @Column({ name: 'status_code', type: 'smallint', unsigned: true, default: 301 })
  statusCode: number;

  @Column({ type: 'int', unsigned: true, default: 0 })
  hits: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
