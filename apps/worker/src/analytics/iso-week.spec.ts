import { describe, expect, it } from 'vitest';

import { isoWeekKey, isoWeekRange, isoWeekToDate } from '@workout-logging/shared';

// Pure, no infra — runs in CI.
describe('ISO week helpers', () => {
  it('isoWeekKey labels the week the date falls in, including year boundaries', () => {
    expect(isoWeekKey(new Date('2026-08-24T12:00:00Z'))).toBe('2026-W35'); // Monday
    expect(isoWeekKey(new Date('2026-08-30T23:00:00Z'))).toBe('2026-W35'); // Sunday
    expect(isoWeekKey(new Date('2026-08-31T00:00:00Z'))).toBe('2026-W36'); // next Monday
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // belongs to 2026
    expect(isoWeekKey(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01'); // belongs to 2026
  });

  it('isoWeekToDate is the inverse of isoWeekKey (round-trips)', () => {
    for (const week of ['2026-W35', '2026-W01', '2026-W53', '2025-W01', '2027-W01']) {
      const d = isoWeekToDate(week);
      expect(d.getUTCDay()).toBe(1); // Monday
      expect(d.getUTCHours()).toBe(0);
      expect(isoWeekKey(d)).toBe(week);
    }
  });

  it('isoWeekToDate throws on a malformed week', () => {
    expect(() => isoWeekToDate('2026-35')).toThrow();
    expect(() => isoWeekToDate('garbage')).toThrow();
  });

  it('isoWeekRange spans exactly Monday 00:00 UTC to the next Monday', () => {
    const { start, end } = isoWeekRange(new Date('2026-08-27T15:00:00Z')); // a Thursday
    expect(start.toISOString()).toBe('2026-08-24T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
});
