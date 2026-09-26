// test/smtp-sink.ts — a minimal in-process SMTP server for specs that need
// to see a real, rendered email (links, subject, HTML). The app is pointed
// at it through PUT /admin/mail/settings (driver 'smtp', host 127.0.0.1, no
// encryption); every message it receives is decoded (encoded-word subject,
// quoted-printable / base64 parts) and kept in `messages`.

import net from 'node:net';
import { adminApi } from './helpers';

export interface SunkMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  raw: string;
}

function decodeWords(value: string): string {
  return value.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc: string, data: string) =>
    enc.toLowerCase() === 'b'
      ? Buffer.from(data, 'base64').toString('utf8')
      : decodeQuotedPrintable(data.replace(/_/g, ' ')),
  );
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const src = value.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(src[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function splitHeaders(part: string): { headers: Record<string, string>; body: string } {
  const idx = part.search(/\r?\n\r?\n/);
  const head = idx === -1 ? part : part.slice(0, idx);
  const body = idx === -1 ? '' : part.slice(idx).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

function decodeBody(headers: Record<string, string>, body: string): string {
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function parseMessage(raw: string, to: string[]): SunkMail {
  const { headers, body } = splitHeaders(raw);
  const mail: SunkMail = { to, subject: decodeWords(headers.subject ?? ''), text: '', html: '', raw };
  const collect = (partHeaders: Record<string, string>, partBody: string) => {
    const type = (partHeaders['content-type'] ?? 'text/plain').toLowerCase();
    const boundary = /boundary="?([^";]+)"?/i.exec(partHeaders['content-type'] ?? '')?.[1];
    if (type.startsWith('multipart/') && boundary) {
      for (const chunk of partBody.split(`--${boundary}`).slice(1)) {
        if (chunk.startsWith('--')) break;
        const sub = splitHeaders(chunk.replace(/^\r?\n/, ''));
        collect(sub.headers, sub.body);
      }
    } else if (type.startsWith('text/html')) {
      mail.html += decodeBody(partHeaders, partBody);
    } else if (type.startsWith('text/plain')) {
      mail.text += decodeBody(partHeaders, partBody);
    }
  };
  collect(headers, body);
  return mail;
}

export class SmtpSink {
  readonly messages: SunkMail[] = [];
  private server?: net.Server;
  port = 0;

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let rcpt: string[] = [];
      socket.write('220 sink ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end === -1) return;
            const raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
            buffer = buffer.slice(end + 5);
            inData = false;
            this.messages.push(parseMessage(raw, rcpt));
            rcpt = [];
            socket.write('250 OK\r\n');
            continue;
          }
          const nl = buffer.indexOf('\r\n');
          if (nl === -1) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 sink\r\n');
          else if (cmd === 'RCPT') {
            rcpt.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            socket.write('250 OK\r\n');
          } else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 go ahead\r\n');
          } else if (cmd === 'QUIT') {
            socket.end('221 bye\r\n');
          } else socket.write('250 OK\r\n');
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Waits until a message matching `predicate` has arrived. */
  async waitFor(predicate: (m: SunkMail) => boolean, timeoutMs = 10_000): Promise<SunkMail> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching mail within ${timeoutMs}ms (got ${this.messages.length}: ${this.messages.map((m) => m.subject).join(' | ')})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Points the app's mail settings at a fresh sink for the duration of `fn`, then restores the previous settings. */
export async function withMailSink<T>(fn: (sink: SmtpSink) => Promise<T>): Promise<T> {
  const sink = new SmtpSink();
  await sink.start();
  const before = await adminApi('GET', '/admin/mail/settings');
  const put = await adminApi('PUT', '/admin/mail/settings', {
    body: {
      isEnabled: true,
      driver: 'smtp',
      host: '127.0.0.1',
      port: sink.port,
      encryption: 'none',
      fromEmail: 'noreply@example.com',
      notifyEmail: 'inbox@example.com',
    },
  });
  if (put.status !== 200) throw new Error(`pointing mail at the sink failed: ${put.status} ${JSON.stringify(put.body)}`);
  try {
    return await fn(sink);
  } finally {
    const b = before.body;
    await adminApi('PUT', '/admin/mail/settings', {
      body: {
        isEnabled: b.isEnabled,
        driver: b.driver,
        host: b.host,
        port: b.port,
        encryption: b.encryption,
        fromEmail: b.fromEmail,
        notifyEmail: b.notifyEmail,
      },
    });
    await sink.stop();
  }
}
