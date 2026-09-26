import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { ARGON2_OPTIONS } from './argon2-options.js';

/** FR-A-01: passwords hashed with Argon2id (ARGON2_OPTIONS). */
@Injectable()
export class PasswordService implements OnModuleInit {
  private dummy: string | undefined;

  /**
   * A2: a hash of a random secret nobody knows, built at boot with the same
   * ARGON2_OPTIONS as every real hash. Sign-ins for an unknown, disabled,
   * invited or brute-force-locked account verify against it, so they cost
   * exactly what a wrong password for an active account costs. (The
   * invited-user placeholder, UNUSABLE_PASSWORD_HASH, is m=1,t=1 and
   * verified ~30× faster — it told a caller which emails were staff.)
   */
  async onModuleInit(): Promise<void> {
    this.dummy = await this.hash(randomBytes(32).toString('base64url'));
  }

  get dummyHash(): string {
    if (!this.dummy) throw new Error('PasswordService.dummyHash read before onModuleInit');
    return this.dummy;
  }

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed/placeholder hash (e.g. an invited user who has not
      // accepted yet) must fail closed, never throw into the caller.
      return false;
    }
  }

  /** A2: the same Argon2 work as `verify()` on a real hash; never accepts anything. */
  async verifyDummy(plain: string): Promise<false> {
    await this.verify(this.dummyHash, plain);
    return false;
  }
}
