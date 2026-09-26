// test/shutdown.spec.ts — A4 (safeer-delivery-review.md): request-otp now
// answers before the code is sent, so a redeploy (PM2 sends SIGTERM) can
// land while a send is still running. main.ts enables Nest's shutdown hooks
// and BackgroundWork drains in beforeApplicationShutdown, so the send (here:
// an SMS that hangs until its 5 s timeout, then the email fallback) still
// completes and is logged before the process goes.
//
// Runs its own API process (the shared one must stay up). Skipped on
// Windows, where Node can't deliver SIGTERM to a child — it only kills it.

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { adminApi, createApplication, deleteApplication, withDb } from './helpers';

const PORT = String(Number(process.env.TEST_PORT ?? 3901) + 1);
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`second API did not become healthy at ${url}`);
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

describeOnPosix('A4: graceful shutdown', () => {
  it('SIGTERM during a hanging SMS still completes the delivery (email fallback) before the process exits', async () => {
    const hanging = http.createServer(() => undefined); // accepts, never responds
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const smsPort = (hanging.address() as any).port;
    const before = await adminApi('GET', '/admin/sms/settings');
    const applicant = await createApplication();
    let child: ChildProcess | undefined;
    try {
      // Settings first: the second process reads them fresh.
      const put = await adminApi('PUT', '/admin/sms/settings', {
        body: { isEnabled: true, driver: 'http', providerUrl: `http://127.0.0.1:${smsPort}/send` },
      });
      expect(put.status).toBe(200);

      child = spawn(process.execPath, ['dist/main.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...JSON.parse(process.env.TEST_APP_ENV ?? '{}'), PORT },
        stdio: 'ignore',
      });
      const exited = exitOf(child);
      await waitForHealth(`http://localhost:${PORT}/health`);

      const res = await fetch(`http://localhost:${PORT}/api/v1/portal/auth/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: applicant.reference, channel: 'sms' }),
      });
      expect([200, 201]).toContain(res.status);

      // The row is committed before the send starts (B1); the SMS is now hanging.
      await new Promise((r) => setTimeout(r, 300));
      const signalledAt = Date.now();
      child.kill('SIGTERM');
      const { code, signal } = await exited;
      const drainedMs = Date.now() - signalledAt;

      // Nest re-raises the signal once its hooks have run; either way the process ended by itself, not by a SIGKILL.
      expect(signal === 'SIGTERM' || code === 0).toBe(true);
      // It waited for the SMS timeout rather than dying at once.
      expect(drainedMs).toBeGreaterThan(3000);

      const [otp]: any = await withDb((conn) =>
        conn.execute('SELECT channel FROM applicant_otps WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicant.id]).then(([rows]: any) => rows),
      );
      expect(otp.channel).toBe('email');
      const [mail]: any = await withDb((conn) =>
        conn
          .execute("SELECT COUNT(*) AS c FROM mail_log WHERE template_key = 'otp_code' AND entity_id = ?", [applicant.id])
          .then(([rows]: any) => rows),
      );
      expect(Number(mail.c)).toBe(1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await adminApi('PUT', '/admin/sms/settings', {
        body: { isEnabled: before.body.isEnabled, driver: before.body.driver, providerUrl: before.body.providerUrl ?? null },
      });
      hanging.closeAllConnections();
      hanging.close();
      await deleteApplication(applicant.id);
    }
  }, 45_000);
});
