import { Inject, Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';

/** The environments where the dev OTP hook exists at all (scripts/lib/node-env.mjs DEV_ENVS). */
export const DEV_HOOK_ENVS: ReadonlyArray<Env['NODE_ENV']> = ['development', 'test'];

export interface PeekedOtp {
  code: string;
  channel: 'sms' | 'email';
  issuedAt: string;
}

/**
 * C1: OTP codes are never stored in plain text — not in `applicant_otps`
 * (only a hash), and no longer in `mail_log`/`sms_log` either. The smoke
 * suite and the Jest specs still need to sign in as an applicant, so in
 * development/test only, PortalOtpService hands the last code per
 * application to this in-memory store, and `GET __dev/otp/:applicationId`
 * reads it back (DevOtpController). In staging/production `record()` is a
 * no-op and the route answers 404, so nothing is ever retained.
 */
@Injectable()
export class OtpPeekService {
  private readonly enabled: boolean;
  private readonly codes = new LRUCache<string, PeekedOtp>({ max: 1000, ttl: 15 * 60 * 1000 });

  constructor(@Inject(ENV) env: Env) {
    this.enabled = DEV_HOOK_ENVS.includes(env.NODE_ENV);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  record(applicationId: string, code: string, channel: 'sms' | 'email'): void {
    if (!this.enabled) return;
    this.codes.set(applicationId, { code, channel, issuedAt: new Date().toISOString() });
  }

  peek(applicationId: string): PeekedOtp | undefined {
    return this.enabled ? this.codes.get(applicationId) : undefined;
  }
}
