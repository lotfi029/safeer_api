import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/user.entity.js';
import type { AuthTokenPurpose } from '../database/entities/auth-token.entity.js';
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
 *    still holding the placeholder hash (003_dev_sample.sql's two editors)
 *    a real, usable password — BOOTSTRAP_ADMIN_PASSWORD, same as the
 *    bootstrap admin. A migration cannot carry a hash derived from .env (it
 *    would go stale the moment the password changed, and it would put a
 *    secret-derived value in a committed file), so 003 seeds an unusable
 *    hash and this is what turns it into something you can actually sign
 *    in with.
 *
 *    B0-6: the candidate set is *not* "every row holding the placeholder
 *    hash" — createInvitedUser() (users.service.ts) sets that exact same
 *    hash on every pending invite, including a pending admin invite. Left
 *    unfiltered, every restart of a dev instance would silently hand
 *    BOOTSTRAP_ADMIN_PASSWORD to anyone with an outstanding invitation,
 *    unlocked, before they ever open the link. A pending invitee always has
 *    an `auth_tokens` row with purpose='invite' (AuthService.invite); the
 *    two seeded accounts never do. Excluding anyone with such a row limits
 *    this to accounts that were actually seeded, not invited.
 */
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
          isLocked: false,
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

    const candidates = await this.userRepo
      .createQueryBuilder('u')
      .where('u.password_hash = :placeholder', { placeholder: UNUSABLE_PASSWORD_HASH })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM auth_tokens t WHERE t.user_id = u.id AND t.purpose = :purpose)`,
        { purpose: 'invite' satisfies AuthTokenPurpose },
      )
      .getMany();
    if (candidates.length === 0) return;

    const devHash = await this.passwordService.hash(this.env.BOOTSTRAP_ADMIN_PASSWORD);
    await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({ passwordHash: devHash })
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
