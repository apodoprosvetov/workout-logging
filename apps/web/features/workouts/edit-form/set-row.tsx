'use client';

import { type SetUnit } from '@lib/contracts/workouts';
import { FORM_INPUT, ICON_BUTTON } from '@lib/ui-styles/form-styles';

import { FieldProblems } from './field-problems';
import { WEIGHT_INCREMENT } from './lib/editor-state';

import type { EditorSet } from './lib/editor-state';

const UNITS: SetUnit[] = ['kg', 'lb'];

export function SetRow({
  set,
  index,
  total,
  problems,
  onChange,
  onRemove,
  onMove,
}: {
  set: EditorSet;
  index: number;
  total: number;
  problems: string[];
  onChange: (next: EditorSet) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-6 text-xs tabular-nums text-zinc-500">{index + 1}</span>
        <input
          type="number"
          inputMode="decimal"
          // Half-kilo jumps for the arrows only — 0.01 would need 500 clicks
          // for 5kg. The form sets noValidate, so a typed 82.25 still saves.
          step={String(WEIGHT_INCREMENT)}
          min="0"
          value={set.weight}
          onChange={(event) => onChange({ ...set, weight: event.target.value })}
          aria-label={`Set ${index + 1} weight`}
          className={`w-24 ${FORM_INPUT}`}
        />
        <select
          value={set.unit}
          onChange={(event) => onChange({ ...set, unit: event.target.value as SetUnit })}
          aria-label={`Set ${index + 1} unit`}
          className={FORM_INPUT}
        >
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min="1"
          value={set.reps}
          onChange={(event) => onChange({ ...set, reps: event.target.value })}
          aria-label={`Set ${index + 1} reps`}
          className={`w-20 ${FORM_INPUT}`}
        />
        <span className="text-sm text-zinc-500">reps</span>

        <button
          type="button"
          onClick={() => onMove(index - 1)}
          disabled={index === 0}
          aria-label={`Move set ${index + 1} up`}
          className={ICON_BUTTON}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove(index + 1)}
          disabled={index === total - 1}
          aria-label={`Move set ${index + 1} down`}
          className={ICON_BUTTON}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove set ${index + 1}`}
          className="px-2 py-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
        >
          ✕
        </button>
      </div>
      <FieldProblems messages={problems} />
    </div>
  );
}
