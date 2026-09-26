import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { User } from '../database/entities/user.entity.js';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken } from '../database/entities/auth-token.entity.js';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { ApplicantSession } from '../database/entities/applicant-session.entity.js';
import { ConfigModule } from '../config/config.module.js';
import { MailModule } from '../mail/mail.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { RolesController } from './roles.controller.js';
import { PasswordService } from './password.service.js';
import { ApplicantSessionService } from './applicant-session.service.js';
import { SessionGuard } from './guards/session.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { CsrfGuard } from './guards/csrf.guard.js';
import { BootstrapService } from './bootstrap.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Session, AuthToken, AuditLog, ApplicantSession]),
    ConfigModule,
    MailModule,
    UsersModule,
  ],
  controllers: [AuthController, RolesController],
  providers: [
    AuthService,
    PasswordService,
    ApplicantSessionService,
    BootstrapService,
    // Registered here, not in AppModule: APP_GUARD providers are applied
    // globally regardless of which module declares them, and this is the
    // module whose own imports (TypeOrmModule.forFeature, ConfigModule)
    // actually satisfy these guards' constructor dependencies. Order
    // matters — Roles reads req.user and Csrf reads req.sessionTokenHash,
    // both written by Session, so Session must resolve first; AppModule
    // lists ThrottlerModule before AuthModule in its own imports so
    // ThrottlerGuard still runs before all three.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [AuthService, PasswordService, ApplicantSessionService],
})
export class AuthModule {}
