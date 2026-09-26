// A2: the hash an unknown / disabled / locked sign-in is checked against is
// built at boot with the same Argon2 cost as a real password hash — the
// old placeholder (m=1,t=1) verified ~30× faster and told a caller which
// staff emails exist.
import 'reflect-metadata';
import { PasswordService } from '../../src/auth/password.service';
import { ARGON2_OPTIONS, argon2Params } from '../../src/auth/argon2-options';
import { UNUSABLE_PASSWORD_HASH } from '../../src/users/users.service';

jest.mock('@nestjs/typeorm', () => ({ InjectRepository: () => () => undefined }));

const expected = { m: ARGON2_OPTIONS.memoryCost, t: ARGON2_OPTIONS.timeCost, p: ARGON2_OPTIONS.parallelism };

describe('PasswordService (A2)', () => {
  const service = new PasswordService();

  beforeAll(async () => {
    await service.onModuleInit();
  });

  it('builds the dummy hash at boot with the same Argon2 parameters as a real hash', async () => {
    const real = await service.hash('a-real-password');
    expect(argon2Params(real)).toEqual(expected);
    expect(argon2Params(service.dummyHash)).toEqual(expected);
    expect(service.dummyHash).toMatch(/^\$argon2id\$/);
  });

  it('matches argon2’s own defaults, so hashes stored before A2 cost the same', async () => {
    const argon2 = await import('argon2');
    const withDefaults = await argon2.hash('x', { type: argon2.argon2id });
    expect(argon2Params(withDefaults)).toEqual(expected);
  });

  it('verifyDummy never accepts anything', async () => {
    await expect(service.verifyDummy('')).resolves.toBe(false);
    await expect(service.verifyDummy('a-real-password')).resolves.toBe(false);
  });

  it('the invited-user placeholder is not what the dummy check uses', () => {
    expect(argon2Params(UNUSABLE_PASSWORD_HASH)).toEqual({ m: 1, t: 1, p: 1 });
    expect(service.dummyHash).not.toBe(UNUSABLE_PASSWORD_HASH);
  });
});
