import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from '../database/entities/application.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { Counter } from '../database/entities/counter.entity.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { ApplicantSessionService } from '../auth/applicant-session.service.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import type { RequestContext } from '../common/request-context.js';
import type { CreateApplicationDto } from './dto/create-application.dto.js';

export interface StartApplicationResult {
  reference: string;
  token: string;
  csrfToken: string;
}

const DEFAULT_REF_PREFIX = 'SA';

@Injectable()
export class ApplicationsService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    private readonly applicantSessions: ApplicantSessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `POST applications` — the public "start an application" entry point.
   * One transaction covers the reference-number mint (`counters`, `SELECT
   * … FOR UPDATE`), the `Draft` row itself, the fresh `applicant_sessions`
   * row and the `STARTED` event: if any of them fails, none of them stick,
   * including the counter increment (a rolled-back transaction never
   * "burns" a reference number). The `application_started` mail is sent
   * only after the transaction commits — a slow/broken mail send must
   * never hold the row lock on `counters` open, and a failed application
   * create must never have already sent a mail for a row that doesn't
   * exist.
   */
  async create(dto: CreateApplicationDto, req: RequestContext): Promise<StartApplicationResult> {
    const { application, token, csrfToken } = await this.applicationRepo.manager.transaction(async (manager) => {
      const settings = await manager.findOne(SiteSettings, { where: { id: '1' } });
      const prefix = settings?.applicationRefPrefix ?? DEFAULT_REF_PREFIX;

      const year = new Date().getFullYear();
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

      return { application, token, csrfToken };
    });

    // Best-effort link to the (Angular) portal's continue-application
    // screen — no dedicated portal front-end route exists to point at yet
    // (there is no Safeer front-end in this repo), so this mirrors
    // AuthService's own admin-side links (`${PUBLIC_BASE_URL}/admin/...`):
    // a plausible path a later front-end phase is expected to serve.
    const link = `${this.env.PUBLIC_BASE_URL}/portal`;
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
