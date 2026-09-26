// C33: the dev password fixup only ever targets an explicit allow-list of
// seeded emails — never a real invitee who happens to have no invite token.
import 'reflect-metadata';

// @nestjs/typeorm ships ESM only; the decorators aren't under test here.
jest.mock('@nestjs/typeorm', () => ({ InjectRepository: () => () => undefined, InjectDataSource: () => () => undefined }));
import { BootstrapService, DEV_SEEDED_USER_EMAILS } from '../../src/auth/bootstrap.service';

describe('BootstrapService dev password fixup (C33)', () => {
  it('with the flag on, touches no user outside DEV_SEEDED_USER_EMAILS', async () => {
    expect(DEV_SEEDED_USER_EMAILS).toEqual([]);
    const queried = jest.fn();
    const userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: '1', email: 'admin@example.com' }),
      createQueryBuilder: () => {
        queried();
        throw new Error('the fixup must not query users when the allow-list is empty');
      },
    };
    const passwordService = { hash: jest.fn() };
    const service = new BootstrapService(userRepo as any, passwordService as any, {
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
      ALLOW_DEV_PASSWORD_FIXUP: true,
      NODE_ENV: 'development',
    } as any);
    await service.onApplicationBootstrap();
    expect(queried).not.toHaveBeenCalled();
    expect(passwordService.hash).not.toHaveBeenCalled();
  });
});
