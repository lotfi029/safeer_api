import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** FR-A-01: passwords hashed with Argon2id. */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
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
}
