// Each e2e spec drives one shared server/database; a slow OTP lockout case,
// an SMS provider timeout or a large bulk action would otherwise trip
// Jest's default 5 s. Set here because Jest ignores `testTimeout` in a
// multi-project config.
jest.setTimeout(30_000);
