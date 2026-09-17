'use client';

import { useChannelStatus } from '@services/workout-events';

/**
 * Says when updates are not arriving — and nothing else.
 *
 * The three rules this has to satisfy (contracts/ui.md "Channel status in the
 * UI") are all about what it must *not* do: never an error, never blocking,
 * never implying data is live when it is not. The visual treatment is
 * deliberately left unspecified there, so what follows is a choice, with its
 * reasoning:
 *
 * **Silent while `connecting`.** Since T046 the server sends a heartbeat the
 * moment the stream opens, so this state is now brief rather than the 15
 * seconds it was when this component was written — but staying silent is still
 * right, and for the reason that outlasted the timing: on first load the data
 * on screen was *just fetched*, so it is current whether or not a stream is
 * open yet. FR-025 forbids presenting stale data as live; it does not require
 * announcing the connection. A badge that appeared on every page load and
 * every reconnect would be noise about a channel that is almost always about
 * to work.
 *
 * **Visible while `offline`.** Here the omission would be a lie: the data on
 * screen may be minutes old and nothing is coming to correct it.
 *
 * **Muted, not red, and not a dialog.** `offline` is a fact about delivery,
 * not a failure of the app — everything still works, reloads still show
 * correct data (FR-026). Styling it as an error would make the enhancement's
 * absence read as a breakage, which is precisely what that requirement rules
 * out.
 */
export function ChannelStatus() {
  const status = useChannelStatus();

  if (status !== 'offline') return null;

  return (
    <span
      className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400"
      // Not `role="alert"` or `aria-live="assertive"`: this is a background
      // condition, not something that happened to the user, and interrupting a
      // screen reader mid-sentence to announce it is its own kind of blocking.
      // `polite` waits for a pause.
      aria-live="polite"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
      Updates paused
    </span>
  );
}
