import { ConsoleLogger, type LogLevel } from '@nestjs/common';

/**
 * M3(a): the string patterns below require the delimiter immediately after
 * the header name (the original regex was `/\b(cookie)\s*[:=]\s*\S+/gi`),
 * but this logger is constructed with `{ json: true }` and therefore only
 * ever emits the JSON-quoted form — `"cookie":"sf_sid=…"`, with a `"`
 * between the key and the colon that the old pattern never accounted for.
 * The patterns as originally written fired only on raw `Cookie: value`
 * text this logger never produces. Each pattern below optionally consumes
 * a surrounding `"` on both the key and the value, so it matches either
 * shape.
 *
 * M3(b): a bigger gap than the string patterns — `redact()` returned
 * immediately for anything that was not a `string`, so
 * `logger.error({ headers: req.headers })` (the single most likely future
 * regression, and exactly what this file's own header comments have long
 * anticipated) passed through completely untouched: `getJsonLogObject`
 * does not stringify an object `message`, it stays a live object all the
 * way to the write call. `redact()` now recurses into objects and arrays
 * and redacts **by key name**, which is the more reliable mechanism for
 * structured data anyway — it doesn't depend on the value's shape looking
 * like anything in particular, only on what it's called.
 *
 * `smtp://user:PASSWORD@host` intentionally removed: `mail-transport.
 * service.ts:76-82` passes discrete `host`/`port`/`auth` to nodemailer and
 * never builds a URL, so this guarded a shape the codebase does not
 * construct. If a future change does build one, add the pattern back.
 */
const SENSITIVE_KEYS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'x-csrf-token',
  'password',
  'passwordencrypted',
  'passwordhash',
  'token',
  'tokenhash',
  'payload',
]);

function headerStringPattern(name: string, hasScheme = false): readonly [RegExp, string] {
  const scheme = hasScheme ? '(?:(?:bearer|basic)\\s+)?' : '';
  // `"?` around both the key and the value makes this match the raw header
  // form (`Cookie: value`) and the `{ json: true }` form (`"cookie":"value"`)
  // with one pattern.
  return [new RegExp(`"?\\b(${name})"?\\s*[:=]\\s*"?${scheme}[^"\\s,}]+"?`, 'gi'), '$1: [REDACTED]'];
}

const STRING_REDACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  headerStringPattern('cookie'),
  headerStringPattern('set-cookie'),
  // `Bearer <token>`/`Basic <token>` carry the credential as a *second*
  // space-separated part — matching only the value here would redact the
  // scheme word and leave the actual token exposed right after it.
  headerStringPattern('authorization', true),
  headerStringPattern('x-csrf-token'),
];

const MAX_REDACT_DEPTH = 8;

function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_REDACT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Recurses into objects/arrays, redacting any property whose key (case-
 * insensitively) names something sensitive, and applies the string
 * patterns to every string value along the way. `seen` guards against a
 * circular structure looping forever; `depth` is a second, cheaper backstop
 * against a pathologically deep (but non-circular) object — this runs on
 * the logging hot path and must never itself be the thing that hangs or
 * crashes the process.
 */
function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[REDACTED: max depth exceeded]';
  if (seen.has(value)) return '[REDACTED: circular reference]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }
  if (value instanceof Date || value instanceof Error) {
    // Neither is a plain data bag worth recursing into key-by-key; an
    // Error's own `message`/`stack` are handled separately by
    // getJsonLogObject below.
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(val, depth + 1, seen);
  }
  return out;
}

type JsonLogOptions = {
  context: string;
  logLevel: LogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
};

/**
 * B2/NFR-11: structured JSON logs, with the redaction pass above. Extends
 * @nestjs/common's own ConsoleLogger — which already has a native
 * `{ json: true }` mode — rather than writing a LoggerService from scratch,
 * since the base class already correctly handles every call-site overload
 * this codebase uses (`error(message, stack)`, `log(message)`,
 * `warn(message)`, the constructor-bound context from every existing
 * `new Logger(ClassName)`); only the final log object needs redacting
 * before it reaches stdout/stderr.
 */
export class RedactingJsonLogger extends ConsoleLogger {
  constructor() {
    super({ json: true });
  }

  protected override getJsonLogObject(message: unknown, options: JsonLogOptions) {
    const logObject = super.getJsonLogObject(message, options);
    return {
      ...logObject,
      message: redact(logObject.message),
      ...(logObject.stack !== undefined ? { stack: redact(logObject.stack) } : {}),
    };
  }

  // Hostinger's runtime-log reader (hPanel and its API) skips any line that
  // isn't JSON with a string `timestamp`, `level` and `message`, and its
  // level filter matches the raw text (`ERROR`, `WARN`). Nest's defaults — a
  // numeric epoch timestamp, lower-case `log`/`error`, and an object
  // `message` left as an object — made every line of this API's log
  // unreadable there. Done here rather than in getJsonLogObject because the
  // base class pins that method's return type to Nest's own shape; the
  // message is already redacted by the time it gets here.
  protected override printAsJson(message: unknown, options: JsonLogOptions): void {
    const logObject = this.getJsonLogObject(message, options);
    const msg = logObject.message;
    const line = JSON.stringify(
      {
        ...logObject,
        level: logObject.level.toUpperCase(),
        timestamp: new Date(logObject.timestamp).toISOString(),
        message:
          typeof msg === 'string'
            ? msg
            : msg instanceof Error
              ? redactString(`${msg.name}: ${msg.message}`)
              : JSON.stringify(msg, this.stringifyReplacer),
      },
      this.stringifyReplacer,
    );
    process[options.writeStreamType ?? 'stdout'].write(`${line}\n`);
  }
}
