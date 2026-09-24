import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ContactMessage } from './contact-message.entity.js';
import { User } from './user.entity.js';
import { MailLog } from './mail-log.entity.js';

@Entity('message_replies')
@Index('ix_replies_message', ['messageId', 'createdAt'])
export class MessageReply {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'message_id', type: 'bigint', unsigned: true })
  messageId: string;

  @ManyToOne(() => ContactMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id', foreignKeyConstraintName: 'fk_reply_message' })
  message?: ContactMessage;

  @Column({ name: 'author_id', type: 'bigint', unsigned: true, nullable: true })
  authorId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'fk_reply_author' })
  author?: User | null;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'mail_log_id', type: 'bigint', unsigned: true, nullable: true })
  mailLogId: string | null;

  @ManyToOne(() => MailLog, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'mail_log_id', foreignKeyConstraintName: 'fk_reply_maillog' })
  mailLog?: MailLog | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
