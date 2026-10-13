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
import { Licence } from './licence.entity.js';
import { ContactMessage } from './contact-message.entity.js';
import { MessageReply } from './message-reply.entity.js';

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
  Licence,
  ContactMessage,
  MessageReply,
};

/**
 * Every entity registered with TypeORM: accounts, files, mail, site,
 * content, voices/partners, documents and the contact inbox.
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
  Licence,
  ContactMessage,
  MessageReply,
];
