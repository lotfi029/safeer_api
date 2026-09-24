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

export { User, Session, AuthToken, AuditLog, MediaAsset, MediaVariant, MailSettings, MailTemplate, MailLog, Redirect };

/**
 * Every entity registered with TypeORM so far. This is a skeleton-port
 * phase: only the infra tables (accounts, files, messaging, redirects)
 * exist. Later phases extend this array as each content module lands its
 * own entity — see app.module.ts's TODO(phase N) comments for which
 * modules are still to come.
 */
export const entities = [User, Session, AuthToken, AuditLog, MediaAsset, MediaVariant, MailSettings, MailTemplate, MailLog, Redirect];
