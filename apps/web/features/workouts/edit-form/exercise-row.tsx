'use client';

import { useMemo, useState } from 'react';

import { FORM_INPUT, ICON_BUTTON } from '@lib/ui-styles/form-styles';

import { FieldProblems } from './field-problems';
import { moveItem, removeAt, replaceAt } from './lib/arrays';
import { emptySet, type EditorExercise } from './lib/editor-state';
import { matchCatalogEntries } from './lib/suggestions';
import { SetRow } from './set-row';

import type { ExerciseCatalogEntry } from '@lib/contracts/exercises';

// How many catalog entries one field offers at a time.
const MAX_SUGGESTIONS = 8;

export function ExerciseRow({
  exercise,
  index,
  total,
  catalog,
  problems,
  setProblems,
  unresolved,
  onChange,
  onRemove,
  onMove,
}: {
  exercise: EditorExercise;
  index: number;
  total: number;
  catalog: ExerciseCatalogEntry[];
  problems: string[];
  setProblems: Map<string, string[]>;
  unresolved: boolean;
  onChange: (next: EditorExercise) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = useMemo(
    () => matchCatalogEntries(catalog, exercise.name).slice(0, MAX_SUGGESTIONS),
    [catalog, exercise.name],
  );

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border p-4 ${
        unresolved || problems.length > 0
          ? 'border-red-400 dark:border-red-700'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex items-start gap-2">
        <div
          className="relative flex-1"
          // On the wrapper, not the input: blurring the input to Tab into a
          // suggestion would otherwise unmount the list before it takes focus,
          // leaving the suggestions reachable by mouse only.
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setShowSuggestions(false);
          }}
        >
          <input
            type="text"
            value={exercise.name}
            onChange={(event) => {
              onChange({ ...exercise, name: event.target.value });
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            placeholder="Exercise name"
            aria-label={`Exercise ${index + 1} name`}
            className={`w-full ${FORM_INPUT}`}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-zinc-300 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900">
              {suggestions.map((entry) => (
                <li key={entry.slug}>
                  <button
                    type="button"
                    // Keeps focus in the input, so a mouse click never fires the
                    // wrapper's blur — browsers disagree about whether mousedown
                    // focuses a button, and the keyboard path does not need it.
                    onMouseDown={(event) => event.preventDefault()}
                    // The canonical name always resolves, so this cannot draw a 400.
                    onClick={() => {
                      onChange({ ...exercise, name: entry.name });
                      setShowSuggestions(false);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-black hover:bg-zinc-100 dark:text-zinc-50 dark:hover:bg-zinc-800"
                  >
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={() => onMove(index - 1)}
          disabled={index === 0}
          aria-label={`Move ${exercise.name || 'exercise'} up`}
          className={ICON_BUTTON}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove(index + 1)}
          disabled={index === total - 1}
          aria-label={`Move ${exercise.name || 'exercise'} down`}
          className={ICON_BUTTON}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${exercise.name || 'exercise'}`}
          className="px-2 py-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
        >
          ✕
        </button>
      </div>

      {unresolved && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Not in the catalog — pick one of the suggested names.
        </p>
      )}
      <FieldProblems messages={problems} />

      <div className="flex flex-col gap-2">
        {exercise.sets.map((set, setIndex) => (
          <SetRow
            key={set.id}
            set={set}
            index={setIndex}
            total={exercise.sets.length}
            problems={setProblems.get(set.id) ?? []}
            onChange={(next) =>
              onChange({ ...exercise, sets: replaceAt(exercise.sets, setIndex, next) })
            }
            onRemove={() => onChange({ ...exercise, sets: removeAt(exercise.sets, setIndex) })}
            onMove={(to) => onChange({ ...exercise, sets: moveItem(exercise.sets, setIndex, to) })}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() =>
          onChange({
            ...exercise,
            // Inherits the previous set's unit — switching mid-exercise is rare.
            sets: [...exercise.sets, emptySet(exercise.sets.at(-1)?.unit)],
          })
        }
        className="w-fit text-sm font-medium text-zinc-600 underline dark:text-zinc-400"
      >
        + Add set
      </button>
    </div>
  );
}
