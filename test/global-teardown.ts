// test/global-teardown.ts — stops the server global-setup.ts started. The
// test database is deliberately left in place (dropped at the *start* of
// the next run instead) so a failed run can be inspected afterwards.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const PID_FILE = path.join(__dirname, '.server.pid');

module.exports = async function globalTeardown() {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  try {
    process.kill(-pid, 'SIGTERM'); // negative pid: the whole detached process group
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  unlinkSync(PID_FILE);
};
