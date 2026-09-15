'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { STATUS_FAILED, STATUS_PENDING, type WorkoutListItem } from '@lib/contracts/workouts';
import { publishWorkoutDeleted, useWorkoutLog } from '@services/workout-events';
import { deleteWorkout, listWorkouts } from '@services/workouts';

/**
 * What the in-flight surface needs to render: the user's workouts that are
 * still being processed or have failed (contracts/ui.md, "New surface").
 *
 * `items` holds both `pending` and `failed` — the modal partitions them itself,
 * because the two are one fetch (`?status=pending&status=failed`) and splitting
 * them here would mean two sources of truth for one list.
 */
export interface InFlightSnapshot {
  readonly items: readonly WorkoutListItem[];
  readonly loading: boolean;
  readonly error: string | null;
  /** How many are in flight — what FR-013 puts on the closed control. */
  readonly count: number;
  /** Refetch on demand: the modal fetches on open even while offline (FR-026). */
  readonly reload: () => void;
  readonly remove: (id: string) => void;
}

// All of these workouts are temporary state.
// If there are rare cases where a customer has more than 50 training sessions,
// this will be an extreme case that we can ignore.
const WORKOUTS_PER_PAGE = 50;

export function useInFlight(): InFlightSnapshot {
  const [items, setItems] = useState<WorkoutListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);

  const { revision } = useWorkoutLog();

  // ignore a response a newer request has superseded.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const seq = (requestSeq.current += 1);
    setError(null);
    try {
      const result = await listWorkouts({
        per_page: WORKOUTS_PER_PAGE,
        status: [STATUS_PENDING, STATUS_FAILED],
      });
      if (seq !== requestSeq.current) return;
      setItems(result.data);
    } catch {
      if (seq !== requestSeq.current) return;
      setError('Could not load the workouts. Please try again.');
    } finally {
      // Only the latest request gets to clear the spinner — an older one
      // finishing after it must not flip `loading` false while the newer
      // request (e.g. the modal's onOpened reload) is still in flight.
      if (seq === requestSeq.current) {
        setLoading(false);
      }
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const index = items.findIndex((w) => w.id === id);
      if (index === -1) return;
      const removed = items[index];

      setItems((current) => current.filter((w) => w.id !== id));

      try {
        await deleteWorkout(id);
        publishWorkoutDeleted();
      } catch {
        setItems((current) => {
          const restored = [...current];
          restored.splice(index, 0, removed);
          return restored;
        });
        setError('Could not delete that workout. Please try again.');
      }
    },
    [items],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [revision, load]);

  return useMemo(() => {
    return {
      items: items,
      loading: isLoading,
      error: error,
      count: items.length,
      reload: () => {
        void load();
      },
      remove: (id: string) => {
        void remove(id);
      },
    };
  }, [items, isLoading, error, load, remove]);
}
