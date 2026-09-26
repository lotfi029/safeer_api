import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { DevOtpController } from './dev-otp.controller.js';
import { OtpPeekService } from './otp-peek.service.js';

@Global()
@Module({
  imports: [ConfigModule, MaintenanceModule],
  controllers: [DevOtpController],
  providers: [OtpPeekService],
  exports: [OtpPeekService],
})
export class DevModule {}
