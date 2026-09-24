import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { AuditInterceptor } from '../common/interceptors/audit.interceptor.js';
import { AuditController } from './audit.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  providers: [AuditInterceptor],
  exports: [AuditInterceptor, TypeOrmModule],
})
export class AuditModule {}
