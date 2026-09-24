import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
