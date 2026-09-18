'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useRequireAuth } from '@hooks/use-require-auth';
import { isEditableStatus } from '@lib/contracts/workouts';
import { FORM_INPUT } from '@lib/ui-styles/form-styles';
import { listExercises } from '@services/exercises';
import { publishWorkoutEdited } from '@services/workout-events';
import { getWorkout, replaceWorkout } from '@services/workouts';

import { ExerciseRow } from './exercise-row';
import { FieldProblems } from './field-problems';
import { moveItem, removeAt, replaceAt } from './lib/arrays';
import {
  emptyExercise,
  toEditorState,
  toReplacePayload,
  validateEditorState,
  type EditorProblem,
  type EditorState,
} from './lib/editor-state';
import { indexProblems } from './lib/problems';
import { describeReplaceFailure, type ReplaceFailure } from './lib/replace-failure';
import { EditScreenMessage } from './screen-message';

import type { EditScreen } from './lib/screen';
import type { ExerciseCatalogEntry } from '@lib/contracts/exercises';

// mount: useRequireAuth -> getWorkout(id) -> toEditorState | "not found" | refuse
//         listExercises                     (failure -> no suggestions)
// save:  validateEditorState -> toReplacePayload -> replaceWorkout
//          200 -> publishWorkoutEdited -> router.push(/workouts?id=)
//          400|409|404|503 -> describeReplaceFailure
//
// The analytics recompute runs behind the API's outbox, so the weekly volume
// lands a moment after the save returns, not with it.

export function WorkoutEditForm({ id }: { id: string }) {
  const authenticated = useRequireAuth();
  const router = useRouter();

  const [screen, setScreen] = useState<EditScreen>({ status: 'loading' });
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const [failure, setFailure] = useState<ReplaceFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<ExerciseCatalogEntry[]>([]);

  const load = useCallback(async () => {
    setScreen({ status: 'loading' });
    setFailure(null);
    setProblems([]);
    try {
      // null is "no such workout"; a real failure still throws.
      const detail = await getWorkout(id);
      if (detail === null) {
        setScreen({ status: 'not-found' });
        return;
      }
      if (!isEditableStatus(detail.status)) {
        setScreen({ status: 'not-editable' });
        return;
      }
      setScreen({ status: 'ready', editor: toEditorState(detail) });
    } catch {
      setScreen({ status: 'error' });
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (authenticated) void load();
  }, [authenticated, load]);

  useEffect(() => {
    if (!authenticated) return;
    // An unreadable catalog leaves the form working without suggestions.
    void listExercises().then(setCatalog, () => setCatalog([]));
  }, [authenticated]);

  const save = useCallback(async () => {
    if (screen.status !== 'ready' || saving) return;

    const found = validateEditorState(screen.editor);
    setProblems(found);
    setFailure(null);
    if (found.length > 0) return;

    setSaving(true);
    try {
      await replaceWorkout(id, toReplacePayload(screen.editor));
      publishWorkoutEdited();
      router.push(`/workouts?id=${id}`);
    } catch (error) {
      setFailure(describeReplaceFailure(error));
      setSaving(false);
    }
    // No `finally`: success navigates away, and re-enabling the button first
    // would flash it.
  }, [id, router, saving, screen]);

  const problemsAt = useMemo(() => indexProblems(problems), [problems]);
  const unresolved = useMemo(
    () => new Set(failure?.unresolvedExercises.map((name) => name.trim().toLowerCase()) ?? []),
    [failure],
  );

  if (!authenticated) return null;
  if (screen.status !== 'ready') {
    return <EditScreenMessage screen={screen} workoutId={id} onRetry={() => void load()} />;
  }

  // Narrowed above, so nothing below re-checks it.
  const editor = screen.editor;
  const update = (next: EditorState) => setScreen({ status: 'ready', editor: next });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <Link
        href={`/workouts?id=${id}`}
        className="text-sm font-medium text-zinc-600 underline dark:text-zinc-400"
      >
        ← Back to workout
      </Link>

      <form
        className="flex flex-col gap-6"
        // validateEditorState is the only judge. Left on, native constraint
        // validation blocks submit before save() runs, so a weight off the
        // step becomes a browser tooltip instead of a message at the field.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Edit workout</h1>

        {failure !== null && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {failure.message}
          </div>
        )}

        {problemsAt.form.map((message) => (
          <p key={message} className="text-sm text-red-600 dark:text-red-400">
            {message}
          </p>
        ))}

        <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Name
          <input
            type="text"
            value={editor.name}
            onChange={(event) => update({ ...editor, name: event.target.value })}
            placeholder="Untitled workout"
            className={FORM_INPUT}
          />
          <FieldProblems messages={problemsAt.name} />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Date and time
          <input
            type="datetime-local"
            value={editor.performedAt}
            onChange={(event) => update({ ...editor, performedAt: event.target.value })}
            className={`w-fit ${FORM_INPUT}`}
          />
          <FieldProblems messages={problemsAt.performedAt} />
        </label>

        <div className="flex flex-col gap-4">
          {editor.exercises.map((exercise, index) => (
            <ExerciseRow
              key={exercise.id}
              exercise={exercise}
              index={index}
              total={editor.exercises.length}
              catalog={catalog}
              problems={problemsAt.exercises.get(exercise.id) ?? []}
              setProblems={problemsAt.sets}
              unresolved={unresolved.has(exercise.name.trim().toLowerCase())}
              onChange={(next) =>
                update({ ...editor, exercises: replaceAt(editor.exercises, index, next) })
              }
              onRemove={() => update({ ...editor, exercises: removeAt(editor.exercises, index) })}
              onMove={(to) =>
                update({ ...editor, exercises: moveItem(editor.exercises, index, to) })
              }
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => update({ ...editor, exercises: [...editor.exercises, emptyExercise()] })}
          className="w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          + Add exercise
        </button>

        <div className="flex items-center gap-3 pt-2">
          {/* A refusal the same content cannot get past — the workout is gone,
              or can no longer be edited — takes the button away rather than
              inviting a retry that must fail. */}
          {failure?.retryable !== false && (
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-black"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
          <Link
            href={`/workouts?id=${id}`}
            className="text-sm font-medium text-zinc-600 underline dark:text-zinc-400"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
