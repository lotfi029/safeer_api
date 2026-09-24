import { User } from './user.entity.js';
import { Session } from './session.entity.js';
import { AuthToken } from './auth-token.entity.js';
import { AuditLog } from './audit-log.entity.js';
import { MediaAsset } from './media-asset.entity.js';
import { MediaVariant } from './media-variant.entity.js';
import { MailSettings } from './mail-settings.entity.js';
import { MailTemplate } from './mail-template.entity.js';
import { MailLog } from './mail-log.entity.js';
import { Redirect } from './redirect.entity.js';
import { SmsSettings } from './sms-settings.entity.js';
import { SmsTemplate } from './sms-template.entity.js';
import { SmsLog } from './sms-log.entity.js';
import { SiteSettings } from './site-settings.entity.js';
import { Page } from './page.entity.js';
import { PageSection } from './page-section.entity.js';
import { Stat } from './stat.entity.js';
import { AboutItem } from './about-item.entity.js';
import { WorkArea } from './work-area.entity.js';
import { WorkAreaItem } from './work-area-item.entity.js';
import { BoardMember } from './board-member.entity.js';
import { NewsCategory } from './news-category.entity.js';
import { Post } from './post.entity.js';
import { NewsletterSubscriber } from './newsletter-subscriber.entity.js';
import { TestimonialTheme } from './testimonial-theme.entity.js';
import { Testimonial } from './testimonial.entity.js';
import { Partner } from './partner.entity.js';
import { DocCategory } from './doc-category.entity.js';
import { SafeerDocument } from './document.entity.js';
import { ContactMessage } from './contact-message.entity.js';
import { MessageReply } from './message-reply.entity.js';
import { Application } from './application.entity.js';
import { ApplicationDocument } from './application-document.entity.js';
import { ApplicationNote } from './application-note.entity.js';
import { ApplicationEvent } from './application-event.entity.js';
import { InterviewSlot } from './interview-slot.entity.js';
import { ApplicantSession } from './applicant-session.entity.js';
import { ApplicantOtp } from './applicant-otp.entity.js';
import { Counter } from './counter.entity.js';

export {
  User,
  Session,
  AuthToken,
  AuditLog,
  MediaAsset,
  MediaVariant,
  MailSettings,
  MailTemplate,
  MailLog,
  Redirect,
  SmsSettings,
  SmsTemplate,
  SmsLog,
  SiteSettings,
  Page,
  PageSection,
  Stat,
  AboutItem,
  WorkArea,
  WorkAreaItem,
  BoardMember,
  NewsCategory,
  Post,
  NewsletterSubscriber,
  TestimonialTheme,
  Testimonial,
  Partner,
  DocCategory,
  SafeerDocument,
  ContactMessage,
  MessageReply,
  Application,
  ApplicationDocument,
  ApplicationNote,
  ApplicationEvent,
  InterviewSlot,
  ApplicantSession,
  ApplicantOtp,
  Counter,
};

/**
 * Every entity registered with TypeORM. Phase 2 adds the full schema
 * (001_schema.sql) and every entity it maps to — accounts/files/mail
 * (phase 1) plus SMS, site, content, voices/partners, documents, inbox and
 * scholarships (phase 2, per the project plan's "Data model" section). The
 * content, messages, applications/portal and admin-applications modules
 * that read and write most of these still land in later phases — see
 * app.module.ts's TODO(phase N) comments for which.
 */
export const entities = [
  User,
  Session,
  AuthToken,
  AuditLog,
  MediaAsset,
  MediaVariant,
  MailSettings,
  MailTemplate,
  MailLog,
  Redirect,
  SmsSettings,
  SmsTemplate,
  SmsLog,
  SiteSettings,
  Page,
  PageSection,
  Stat,
  AboutItem,
  WorkArea,
  WorkAreaItem,
  BoardMember,
  NewsCategory,
  Post,
  NewsletterSubscriber,
  TestimonialTheme,
  Testimonial,
  Partner,
  DocCategory,
  SafeerDocument,
  ContactMessage,
  MessageReply,
  Application,
  ApplicationDocument,
  ApplicationNote,
  ApplicationEvent,
  InterviewSlot,
  ApplicantSession,
  ApplicantOtp,
  Counter,
];
