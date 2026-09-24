import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opts a route out of SessionGuard (and, transitively, CsrfGuard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
