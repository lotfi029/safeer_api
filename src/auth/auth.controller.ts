import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { InviteDto } from './dto/invite.dto.js';
import { AcceptInviteDto } from './dto/accept-invite.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { Public } from './decorators/public.decorator.js';
import { Roles } from './decorators/roles.decorator.js';
import { computeCsrfToken } from './csrf.util.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { UsersService } from '../users/users.service.js';
import { toPublicUser } from '../users/public-user.js';
import type { RequestContext } from '../common/request-context.js';

/**
 * Every route below requires SessionGuard to have already run — i.e. a
 * valid session — except the five marked `@Public()`: login (nothing to
 * validate against yet), invite-accept and forgot/reset (authenticated by
 * the emailed token itself, not a session).
 */
@Controller('admin')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5/min per IP; per-email limit is inside AuthService
  @Post('auth/login')
  async login(@Body() dto: LoginDto, @Req() req: RequestContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto.email, dto.password, req);
    this.setSessionCookie(res, result.token);
    return { user: result.user, csrfToken: result.csrfToken };
  }

  @ApiCookieAuth()
  @Post('auth/logout')
  async logout(@Req() req: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.sessionId!);
    res.clearCookie(this.env.SESSION_COOKIE_NAME, { path: '/' });
    req.auditContext = { action: 'update', entityType: 'sessions', entityId: req.sessionId, entityLabel: 'Sign out' };
    return { ok: true };
  }

  @ApiCookieAuth()
  @Get('me')
  async me(@Req() req: RequestContext) {
    const user = await this.usersService.findById(req.user!.id);
    return {
      ...toPublicUser(user),
      csrfToken: computeCsrfToken(this.env.APP_ENCRYPTION_KEY, req.sessionTokenHash!),
    };
  }

  @ApiCookieAuth()
  @Get('auth/sessions')
  listSessions(@Req() req: RequestContext) {
    return this.authService.listSessions(req.user!.id, req.sessionId!);
  }

  @ApiCookieAuth()
  @Delete('auth/sessions/:id')
  async endSession(@Param('id') id: string, @Req() req: RequestContext) {
    await this.authService.endSession(req.user!.id, req.user!.role, id);
    req.auditContext = { action: 'update', entityType: 'sessions', entityId: id, entityLabel: 'End session' };
    return { ok: true };
  }

  @ApiCookieAuth()
  @Delete('auth/sessions')
  async endOtherSessions(@Req() req: RequestContext) {
    const count = await this.authService.endOtherSessions(req.user!.id, req.sessionId!);
    req.auditContext = { action: 'update', entityType: 'sessions', entityLabel: `Ended ${count} other session(s)` };
    return { ended: count };
  }

  @ApiCookieAuth()
  @Patch('auth/password')
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: RequestContext) {
    await this.authService.changePassword(req.user!.id, dto.currentPassword, dto.newPassword, req.sessionId!);
    req.auditContext = { action: 'update', entityType: 'users', entityId: req.user!.id, entityLabel: 'Password change' };
    return { ok: true };
  }

  @Roles('admin')
  @ApiCookieAuth()
  @Post('auth/invite')
  async invite(@Body() dto: InviteDto, @Req() req: RequestContext) {
    const inviter = await this.usersService.findById(req.user!.id);
    const created = await this.authService.invite(toPublicUser(inviter), dto.email, dto.name, dto.role);
    req.auditContext = { action: 'create', entityType: 'users', entityId: created.id, entityLabel: created.name, after: created };
    return created;
  }

  @Public()
  @Post('auth/accept/:token')
  async acceptInvite(@Param('token') token: string, @Body() dto: AcceptInviteDto, @Req() req: RequestContext) {
    const user = await this.authService.acceptInvite(token, dto.password);
    req.auditContext = { action: 'update', entityType: 'users', entityId: user.id, entityLabel: user.name };
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) // 3/hour/IP
  @Post('auth/forgot')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
    // Always the same response, whether or not the address exists (FR-A-10).
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('auth/reset/:token')
  async resetPassword(@Param('token') token: string, @Body() dto: ResetPasswordDto, @Req() req: RequestContext) {
    const user = await this.authService.resetPassword(token, dto.password);
    req.auditContext = { action: 'update', entityType: 'users', entityId: user.id, entityLabel: user.name };
    return { ok: true };
  }

  private setSessionCookie(res: Response, token: string): void {
    res.cookie(this.env.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: this.env.SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000,
    });
  }
}
