'use client';

import { useEffect, useRef } from 'react';

// The one modal shell in apps/web. Owns the <dialog> element and everything
// that comes with driving one; callers supply only the title and the contents.
//
// It lives in components/ rather than beside either caller because it is the
// one piece here that genuinely is shared chrome — the same rule that keeps
// header/, sidebar/ and workout-table.tsx in this directory. The surfaces it
// hosts are not: each has exactly one caller and lives under features/.
//
// Before this existed the same twenty lines were written twice, in
// log-workout-button.tsx and in the in-flight modal, and had already drifted:
// only one of the two capped its height, so a long list grew the dialog past
// the viewport with no way to scroll it.
//
// Call order, since this crosses files:
//   caller sets `open` -> the effect below calls dialog.showModal()
//     -> `onOpened` fires (the in-flight surface refetches here, FR-026)
//   Esc / backdrop / the close button -> `onClose` -> caller clears `open`
export function Modal({
  open,
  title,
  onClose,
  onOpened,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Called once per open, after the dialog is showing. */
  onOpened?: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // showModal() rather than the `open` attribute, and rather than a React
  // portal: it puts the element in the browser's top layer, which sits above
  // every stacking context on the page by definition, so nothing the header or
  // a page wrapper does can clip it. The backdrop, the focus trap and
  // Esc-to-close arrive with it instead of being rebuilt here.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      onOpened?.();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, onOpened]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // A click whose target is the <dialog> itself landed on the backdrop.
        if (e.target === dialogRef.current) onClose();
      }}
      aria-label={title}
      className="m-auto w-full max-w-lg rounded-lg bg-transparent p-0 backdrop:bg-black/40"
    >
      {/* Contents are mounted only while open, so every surface starts fresh.
          The logging form depends on this for more than tidiness: it revokes
          the object URLs behind its image previews on unmount. */}
      {open && (
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-lg bg-white p-6 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
