import { Global, Module } from '@nestjs/common';
import { BackgroundWork } from './background-work.service.js';

/** A4: one app-wide BackgroundWork, so `settled()` and the shutdown drain see every task. */
@Global()
@Module({
  providers: [BackgroundWork],
  exports: [BackgroundWork],
})
export class BackgroundWorkModule {}
