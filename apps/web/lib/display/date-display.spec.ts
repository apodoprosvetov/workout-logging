// Pinned before anything reads a Date: these two conversions are defined in
// the viewer's local zone, and in UTC the interesting case — a local date that
// is not the UTC date — cannot happen at all.
process.env.TZ = 'America/New_York';

import { describe, expect, it } from 'vitest';

import { fromDateTimeLocal, toDateTimeLocal } from './date-display';

describe('datetime-local conversion', () => {
  it('round-trips an instant', () => {
    const iso = '2026-06-10T14:30:00.000Z';

    expect(fromDateTimeLocal(toDateTimeLocal(iso))).toBe(iso);
  });

  it('renders the local wall clock, not the UTC one', () => {
    // 01:30 UTC on the 11th is 21:30 on the 10th in New York.
    expect(toDateTimeLocal('2026-06-11T01:30:00.000Z')).toBe('2026-06-10T21:30');
  });

  it('reads a local wall clock as local, not as UTC', () => {
    expect(fromDateTimeLocal('2026-06-10T21:30')).toBe('2026-06-11T01:30:00.000Z');
  });

  it('keeps a value whose local date is a day behind the UTC date', () => {
    const iso = '2026-01-01T02:00:00.000Z';
    const local = toDateTimeLocal(iso);

    expect(local.startsWith('2025-12-31')).toBe(true);
    expect(fromDateTimeLocal(local)).toBe(iso);
  });
});
