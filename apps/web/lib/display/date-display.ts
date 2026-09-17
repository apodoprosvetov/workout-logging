// Every date→string formatter in apps/web, together on purpose: they disagree
// about locale and timezone, and that is only visible when they sit side by
// side.
//
//   formatPerformedAt       viewer's locale, viewer's timezone
//   formatPerformedAtShort  en-GB,           viewer's timezone
//   formatDayMonth          en-GB,           UTC
//
// The split is deliberate, not drift. The first two render a workout's
// performed_at, which is a moment the user lived through in their own timezone.
// The third labels week boundaries, which lib/weeks.ts computes in UTC — render
// those locally and a Monday 00:00 UTC boundary shows as the previous Sunday
// for anyone west of Greenwich.

// Full form for the detail page, e.g. "6 Jun 2026". Locale left undefined so
// the viewer's own ordering applies — there is room here for either.
export function formatPerformedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Compact form for list rows, e.g. "Mon, 6 Jun". en-GB pins the day-before-month
// order regardless of the viewer's locale so the date column stays fixed-width.
export function formatPerformedAtShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

// `D Mon` (e.g. `10 Jun`) for a date, in UTC.
export function formatDayMonth(date: Date): string {
  // en-GB orders day before month ("10 Jun"); en-US would give "Jun 10".
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
