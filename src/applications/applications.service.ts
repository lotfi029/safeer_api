import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application, NON_TERMINAL_APPLICATION_STATUSES } from '../database/entities/application.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { Counter } from '../database/entities/counter.entity.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { ApplicantSessionService } from '../auth/applicant-session.service.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import type { CreateApplicationDto } from './dto/create-application.dto.js';
import { normalizePhone } from '../common/phone.js';
import { portalLoginUrl } from '../common/links/frontend-url.js';

export interface StartApplicationResult {
  reference: string;
  token: string;
  csrfToken: string;
}

const DEFAULT_REF_PREFIX = 'SA';

type CreateOutcome =
  | { kind: 'created'; application: Application; token: string; csrfToken: string }
  | { kind: 'duplicate'; existing: Application };

@Injectable()
export class ApplicationsService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(SMS_SERVICE) private readonly smsService: SmsServiceInterface,
    private readonly applicantSessions: ApplicantSessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `POST applications` — the public "start an application" entry point.
   * One transaction covers the duplicate check (B2, safeer-backend-fr-review.md),
   * the reference-number mint (`counters`, `SELECT … FOR UPDATE`), the
   * `Draft` row itself, the fresh `applicant_sessions` row and the
   * `STARTED` event: if any of them fails, none of them stick, including
   * the counter increment (a rolled-back transaction never "burns" a
   * reference number). The `application_started`/`application_resume` mail
   * is sent only after the transaction commits — a slow/broken mail send
   * must never hold the row lock on `counters` (or on the matched
   * duplicate) open, and a failed application create must never have
   * already sent a mail for a row that doesn't exist.
   */
  async create(dto: CreateApplicationDto, req: RequestContext): Promise<StartApplicationResult> {
    const outcome = await this.applicationRepo.manager.transaction<CreateOutcome>(async (manager) => {
      // B2: block a second active application for the same email or phone
      // rather than silently creating one findApplication() could never
      // deterministically pick between. `pessimistic_write` on the matching
      // row(s) makes two concurrent `POST applications` for the same
      // contact details serialise instead of both slipping through.
      const phoneE164 = normalizePhone(dto.phone);
      const duplicateQb = manager
        .createQueryBuilder(Application, 'a')
        .setLock('pessimistic_write')
        .where('a.status IN (:...nonTerminal)', { nonTerminal: NON_TERMINAL_APPLICATION_STATUSES })
        .andWhere('(LOWER(a.email) = LOWER(:email)' + (phoneE164 ? ' OR a.phone_e164 = :phoneE164)' : ')'), {
          email: dto.email,
          ...(phoneE164 ? { phoneE164 } : {}),
        })
        .orderBy('a.created_at', 'DESC');
      const existing = await duplicateQb.getOne();
      if (existing) {
        return { kind: 'duplicate', existing };
      }

      const settings = await manager.findOne(SiteSettings, { where: { id: '1' } });
      const prefix = settings?.applicationRefPrefix ?? DEFAULT_REF_PREFIX;

      const year = new Date().getUTCFullYear(); // C9: the reference year is the UTC year
      const counterKey = `application:${year}`;

      let counter = await manager
        .createQueryBuilder(Counter, 'c')
        .setLock('pessimistic_write')
        .where('c.key = :key', { key: counterKey })
        .getOne();

      if (!counter) {
        // First application of the year on this database. Insert-then-lock
        // rather than lock-then-insert: a plain INSERT takes its own
        // exclusive lock on the new row, so a concurrent request racing to
        // create the same yearly counter fails on the unique primary key
        // instead of both proceeding from value 0. That race loser simply
        // re-reads (now locked, now present) rather than erroring out.
        try {
          counter = await manager.save(manager.create(Counter, { key: counterKey, value: 0 }));
        } catch {
          counter = await manager
            .createQueryBuilder(Counter, 'c')
            .setLock('pessimistic_write')
            .where('c.key = :key', { key: counterKey })
            .getOne();
        }
      }
      if (!counter) {
        throw new Error(`Failed to mint or read the ${counterKey} counter`);
      }

      counter.value += 1;
      await manager.save(counter);

      const sequence = String(counter.value).padStart(5, '0');
      const reference = `${prefix}-${year}-${sequence}`;

      const application = manager.create(Application, {
        reference,
        status: 'draft',
        currentStep: 1,
        firstName: dto.firstName,
        middleName: dto.middleName ?? null,
        lastName: dto.lastName,
        birthDate: dto.birthDate,
        phone: dto.phone,
        nationality: dto.nationality,
        idNumber: dto.idNumber ?? null,
        email: dto.email,
        currentJob: dto.currentJob ?? null,
        gender: dto.gender,
        locale: req.locale,
      });
      await manager.save(application);

      const { token, csrfToken } = await this.applicantSessions.mint(manager, application.id, req);

      await manager.save(
        manager.create(ApplicationEvent, {
          applicationId: application.id,
          type: 'STARTED',
          actorId: null,
          visibleToApplicant: true,
          data: { reference },
        }),
      );

      return { kind: 'created', application, token, csrfToken };
    });

    if (outcome.kind === 'duplicate') {
      // B2: notify the *existing* application's own stored contact
      // details — never the newly submitted email/phone, so this can't be
      // used to redirect a resume link to an address the applicant doesn't
      // control. Non-enumerating wording: the 409 never says which of
      // email/phone matched, or reveals the existing reference.
      const { existing } = outcome;
      const link = portalLoginUrl(this.env, existing.locale);
      await this.mailService.send({
        key: 'application_resume',
        to: existing.email ?? '',
        vars: { name: `${existing.firstName ?? ''} ${existing.lastName ?? ''}`.trim(), reference: existing.reference, link },
        locale: existing.locale,
        entity: { type: 'applications', id: existing.id },
      });
      const existingPhone = existing.phoneE164 ?? existing.phone;
      if (existingPhone && (await this.smsService.availability()) === 'real') {
        await this.smsService.send({
          key: 'application_resume',
          to: existingPhone,
          vars: { reference: existing.reference, link },
          locale: existing.locale,
          entity: { type: 'applications', id: existing.id },
        });
      }

      throw new ProblemException(
        409,
        ErrorCode.APPLICATION_EXISTS,
        'An application is already in progress for these details — instructions to continue it have been sent to its registered contact details',
      );
    }

    const { application, token, csrfToken } = outcome;
    const link = portalLoginUrl(this.env, application.locale);
    await this.mailService.send({
      key: 'application_started',
      to: application.email ?? '',
      vars: {
        name: `${application.firstName ?? ''} ${application.lastName ?? ''}`.trim(),
        reference: application.reference,
        link,
      },
      locale: application.locale,
      entity: { type: 'applications', id: application.id },
    });

    return { reference: application.reference, token, csrfToken };
  }
}
