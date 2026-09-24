import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { Application } from './application.entity.js';

@Entity('interview_slots')
@Unique('uq_slot_application', ['applicationId'])
@Index('ix_slots_time', ['startsAt'])
export class InterviewSlot {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'starts_at', type: 'datetime', precision: 3 })
  startsAt: Date;

  @Column({ name: 'ends_at', type: 'datetime', precision: 3 })
  endsAt: Date;

  @Column({ name: 'location_ar', type: 'varchar', length: 255, nullable: true })
  locationAr: string | null;

  @Column({ name: 'location_en', type: 'varchar', length: 255, nullable: true })
  locationEn: string | null;

  /** NULL = open; set once booked, at most one application per slot */
  @Column({ name: 'application_id', type: 'bigint', unsigned: true, nullable: true })
  applicationId: string | null;

  @ManyToOne(() => Application, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_slots_application' })
  application?: Application | null;

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
