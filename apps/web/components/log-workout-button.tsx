import { useEffect, useRef, useState } from 'react';
import { useIsAuthenticated } from '@hooks/use-require-auth';
import { LogWorkoutForm } from './log-workout-form';

// Header trigger + modal host for LogWorkoutForm. Rendered in the header but
// only for a signed-in visitor (useIsAuthenticated → localStorage token store).
export function LogWorkoutButton() {
  const authenticated = useIsAuthenticated();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // Drive the native <dialog> from React state. showModal() gives us the
  // backdrop, focus trap and Esc-to-close for free; onClose keeps state in sync
  // when the dialog closes by any of those paths.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!authenticated) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        Log workout
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A click whose target is the <dialog> itself landed on the backdrop.
          if (e.target === dialogRef.current) setOpen(false);
        }}
        className="m-auto w-full max-w-lg rounded-lg bg-transparent p-0 backdrop:bg-black/40"
      >
        {/* Mounted only while open so the form (and its object-URL cleanup)
            starts fresh every time the modal is opened. */}
        {open && (
          <div className="flex flex-col gap-4 rounded-lg bg-white p-6 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Log a workout</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
            <LogWorkoutForm onLogged={() => setOpen(false)} />
          </div>
        )}
      </dialog>
    </>
  );
}
