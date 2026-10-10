// test/bind-host.spec.ts — BF-4/S2: the app binds HOST (127.0.0.1 here,
// global-setup.ts), so it answers on loopback and refuses the machine's
// other addresses. Before HOST existed, app.listen(PORT) bound every
// interface.

import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';

const PORT = Number(new URL(process.env.TEST_HEALTH_URL!).port);

function externalIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('HOST (BF-4)', () => {
  it('answers on 127.0.0.1', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
  });

  const external = externalIPv4();
  (external ? it : it.skip)(`refuses a connection on the machine's own address (${external ?? 'none'})`, async () => {
    expect(await canConnect(external!, PORT)).toBe(false);
  });
});
