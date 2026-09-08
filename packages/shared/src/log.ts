// Structured logging, shared by apps/api and apps/worker.
//
// One JSON object per line: `{ts, level, svc, msg, ...fields}`. Deliberately
// dependency-free — a parseable line is all a personal-scale service needs, and
// whatever ships logs later (CloudWatch, `docker logs | jq`, …) can consume it
// without pino/winston in the bundle. info/debug go to stdout, warn/error to
// stderr (so `docker logs` severity splitting and most log shippers do the
// right thing by default).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
  // An Error (or anything) under `err` is expanded to {name, message, stack}.
  err?: unknown;
}

export function logLine(svc: string, level: LogLevel, msg: string, fields: LogFields = {}): void {
  const { err, ...rest } = fields;
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, svc, msg, ...rest };
  if (err !== undefined) {
    line.err =
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : String(err);
  }
  const serialised = safeStringify(line);
  if (level === 'warn' || level === 'error') console.error(serialised);
  else console.log(serialised);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // A circular ref in a caller-supplied field shouldn't lose the log line.
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      svc: 'log',
      msg: 'unserialisable log line',
    });
  }
}

export interface AppLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

// Bound to one service name, e.g. `const log = createLogger('worker')`.
export function createLogger(svc: string): AppLogger {
  return {
    debug: (msg, fields) => logLine(svc, 'debug', msg, fields),
    info: (msg, fields) => logLine(svc, 'info', msg, fields),
    warn: (msg, fields) => logLine(svc, 'warn', msg, fields),
    error: (msg, fields) => logLine(svc, 'error', msg, fields),
  };
}
