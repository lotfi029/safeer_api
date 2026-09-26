import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/user.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { PasswordService } from './password.service.js';
import { UNUSABLE_PASSWORD_HASH } from '../users/users.service.js';

/**
 * Two jobs, both from 13-backend-build-plan.md P3/P6:
 *
 * 1. Always (every environment): ensure BOOTSTRAP_ADMIN_EMAIL exists as an
 *    admin, hashed at runtime. 002_seed.sql deliberately seeds no users, so
 *    on a brand new database this is the only way an admin account exists
 *    at all.
 *
 * 2. Only when ALLOW_DEV_PASSWORD_FIXUP=true (never true in production —
 *    B0-1's schema refuses that combination at boot): give a *seeded* user
 *    still holding the placeholder hash a real, usable password —
 *    BOOTSTRAP_ADMIN_PASSWORD, same as the bootstrap admin. A migration
 *    cannot carry a hash derived from .env, so a dev fixture would seed an
 *    unusable hash and this turns it into something you can sign in with.
 *
 *    C33: the candidates are an explicit allow-list of seeded emails
 *    (DEV_SEEDED_USER_EMAILS), not "placeholder hash and no invite token".
 *    createInvitedUser() gives every pending invite that same placeholder
 *    hash, and an invite whose token was consumed, purged or expired has no
 *    token row left, so the old filter could hand BOOTSTRAP_ADMIN_PASSWORD
 *    to a real invitee on a staging-like instance. The dev fixtures
 *    (migrations/dev/003) currently seed no staff users, so the list is
 *    empty and the fixup does nothing; add an email here together with a
 *    fixture that seeds it.
 */
export const DEV_SEEDED_USER_EMAILS: readonly string[] = [];

@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly passwordService: PasswordService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const admin = await this.userRepo.findOne({ where: { email: this.env.BOOTSTRAP_ADMIN_EMAIL } });
    if (!admin) {
      const passwordHash = await this.passwordService.hash(this.env.BOOTSTRAP_ADMIN_PASSWORD);
      await this.userRepo.save(
        this.userRepo.create({
          email: this.env.BOOTSTRAP_ADMIN_EMAIL,
          name: 'Admin',
          role: 'admin',
          passwordHash,
          status: 'active',
        }),
      );
      this.logger.log(`Bootstrap admin created: ${this.env.BOOTSTRAP_ADMIN_EMAIL}`);
    }

    if (!this.env.ALLOW_DEV_PASSWORD_FIXUP) return;
    // Defensive: the env schema already refuses production+flag at boot
    // (B0-1), but this must never run in production even if that schema is
    // ever loosened later.
    if (this.env.NODE_ENV === 'production') {
      this.logger.error('ALLOW_DEV_PASSWORD_FIXUP is set but NODE_ENV=production — refusing to run the dev password fixup');
      return;
    }

    if (DEV_SEEDED_USER_EMAILS.length === 0) return;
    const candidates = await this.userRepo
      .createQueryBuilder('u')
      .where('u.email IN (:...emails)', { emails: [...DEV_SEEDED_USER_EMAILS] })
      .andWhere('u.password_hash = :placeholder', { placeholder: UNUSABLE_PASSWORD_HASH })
      .getMany();
    if (candidates.length === 0) return;

    const devHash = await this.passwordService.hash(this.env.BOOTSTRAP_ADMIN_PASSWORD);
    await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({ passwordHash: devHash, status: 'active' })
      // Re-assert the placeholder in the WHERE (not just id IN (...)) so a
      // user who accepts their invite between the SELECT above and this
      // UPDATE — unlikely, but not impossible — cannot be clobbered.
      .where('id IN (:...ids)', { ids: candidates.map((c) => c.id) })
      .andWhere('password_hash = :placeholder', { placeholder: UNUSABLE_PASSWORD_HASH })
      .execute();
    this.logger.warn(
      `Dev password fixup applied to: ${candidates.map((c) => c.email).join(', ')} — now sign in with BOOTSTRAP_ADMIN_PASSWORD`,
    );
  }
}
