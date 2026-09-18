// Tailwind class strings for form controls, kept beside workout-styles.ts for
// the same reason: a class name is not part of any contract, and the same
// control appearing differently on two screens reads as a bug.
//
// Separate from workout-styles.ts because nothing here is about a workout —
// these are the text/number/date inputs and the small square buttons used by
// the auth, log and edit forms alike.

export const FORM_INPUT =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50';

// The compact bordered button used for row controls (move up/down).
export const ICON_BUTTON =
  'rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900';
