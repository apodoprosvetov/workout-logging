import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from './structured-logger';

describe('StructuredLogger (Nest LoggerService adapter)', () => {
  const logger = new StructuredLogger();
  afterEach(() => vi.restoreAllMocks());

  function capture(fn: () => void): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [];
    const push = (...a: unknown[]): void => void lines.push(JSON.parse(a[0] as string) as Record<string, unknown>);
    vi.spyOn(console, 'log').mockImplementation(push);
    vi.spyOn(console, 'error').mockImplementation(push);
    fn();
    return lines;
  }

  it('maps log() to an info line and keeps the Nest context', () => {
    const [line] = capture(() => logger.log('RabbitMQ publisher connected', 'RabbitMqPublisherService'));
    expect(line).toMatchObject({
      level: 'info',
      svc: 'api',
      msg: 'RabbitMQ publisher connected',
      context: 'RabbitMqPublisherService',
    });
  });

  it('error() with (message, stack, context) splits stack and context', () => {
    const [line] = capture(() => logger.error('boom', 'Error: boom\n    at x', 'SomeService'));
    expect(line).toMatchObject({ level: 'error', msg: 'boom', context: 'SomeService' });
    expect(line.stack).toContain('at x');
  });

  it('error() with a single non-stack string treats it as context', () => {
    const [line] = capture(() => logger.error('boom', 'SomeService'));
    expect(line.context).toBe('SomeService');
    expect(line.stack).toBeUndefined();
  });

  it('serialises a non-string message', () => {
    const [line] = capture(() => logger.warn({ code: 'E_X', detail: 1 }));
    expect(line.level).toBe('warn');
    expect(JSON.parse(line.msg as string)).toEqual({ code: 'E_X', detail: 1 });
  });

  it('maps verbose() to debug', () => {
    const [line] = capture(() => logger.verbose('trace', 'Ctx'));
    expect(line.level).toBe('debug');
  });
});
