import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from './logger.js';

describe('worker structured logger', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(fn: () => void): { out: unknown[]; err: unknown[] } {
    const out: unknown[] = [];
    const errs: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a[0]));
    vi.spyOn(console, 'error').mockImplementation((...a) => void errs.push(a[0]));
    fn();
    return { out, err: errs };
  }

  it('emits one JSON line per call with ts/level/svc/msg and extra fields', () => {
    const { out } = capture(() => log.info('worker started', { consumers: 2 }));
    expect(out).toHaveLength(1);
    const line = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', svc: 'worker', msg: 'worker started', consumers: 2 });
    expect(typeof line.ts).toBe('string');
    expect(new Date(line.ts as string).toISOString()).toBe(line.ts);
  });

  it('sends info/debug to stdout and warn/error to stderr', () => {
    const { out, err } = capture(() => {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    });
    expect(out.map((l) => (JSON.parse(l as string) as { msg: string }).msg)).toEqual(['d', 'i']);
    expect(err.map((l) => (JSON.parse(l as string) as { msg: string }).msg)).toEqual(['w', 'e']);
  });

  it('expands an Error under `err` to {name, message, stack}', () => {
    const { err } = capture(() => log.error('parse failed', { workout_id: 'w1', err: new TypeError('nope') }));
    const line = JSON.parse(err[0] as string) as { workout_id: string; err: Record<string, unknown> };
    expect(line.workout_id).toBe('w1');
    expect(line.err.name).toBe('TypeError');
    expect(line.err.message).toBe('nope');
    expect(typeof line.err.stack).toBe('string');
  });

  it('stringifies a non-Error `err`', () => {
    const { err } = capture(() => log.error('x', { err: { code: 42 } }));
    const line = JSON.parse(err[0] as string) as { err: unknown };
    expect(line.err).toBe('[object Object]');
  });

  it('never throws on a circular field — emits a fallback line', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { err } = capture(() => log.error('circular', { circular }));
    expect(err).toHaveLength(1);
    expect(() => JSON.parse(err[0] as string)).not.toThrow();
  });
});
