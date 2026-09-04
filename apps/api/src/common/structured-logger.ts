import { LoggerService } from '@nestjs/common';
import { logLine, LogLevel } from '@workout-logging/shared';

const LEVEL_MAP: Record<string, LogLevel> = {
  log: 'info',
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  verbose: 'debug',
  fatal: 'error',
};

// Adapts Nest's LoggerService onto the shared structured JSON logger, so every
// `new Logger(SomeContext)` line in apps/api (and Nest's own bootstrap logs)
// comes out as one parseable `{ts,level,svc:"api",context,msg}` object.
//
// Nest's call shapes we normalise:
//   log(message, context?)
//   warn(message, context?)
//   error(message, stack?, context?)   ← stack is a string when present
export class StructuredLogger implements LoggerService {
  private emit(nestLevel: string, message: unknown, params: unknown[]): void {
    const level = LEVEL_MAP[nestLevel] ?? 'info';
    const strings = params.filter((p): p is string => typeof p === 'string');

    let stack: string | undefined;
    let context: string | undefined;
    if (nestLevel === 'error' && strings.length >= 2) {
      [stack, context] = strings;
    } else if (nestLevel === 'error' && strings.length === 1) {
      // Could be either a stack or a context — a newline means it's a stack.
      if (strings[0].includes('\n')) stack = strings[0];
      else context = strings[0];
    } else if (strings.length >= 1) {
      context = strings[strings.length - 1];
    }

    logLine('api', level, stringify(message), {
      ...(context ? { context } : {}),
      ...(stack ? { stack } : {}),
    });
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }
}

function stringify(message: unknown): string {
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
