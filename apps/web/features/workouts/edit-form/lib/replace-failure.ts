// Turns a refused PUT /workouts/:id into something a reader can act on.
//
// services/workouts.ts keeps its rule that callers never inspect status codes;
// this is the one place that does, because the four refusals mean four
// different things to someone mid-edit. Pure, so it is covered without a DOM.

import { ApiError } from '@services/api-client';

export interface ReplaceFailure {
  /** Rendered as-is. Never empty, whatever the body turned out to be. */
  message: string;
  /** Names from a 400's `unresolved_exercises`; empty for every other refusal. */
  unresolvedExercises: string[];
  /**
   * Whether trying the same content again could work. False for a workout that
   * can no longer be edited or is gone — the form stops offering to save
   * instead of inviting a retry that cannot succeed.
   */
  retryable: boolean;
}

interface UnresolvedBody {
  message?: unknown;
  unresolved_exercises?: unknown;
}

export function describeReplaceFailure(error: unknown): ReplaceFailure {
  if (!(error instanceof ApiError)) {
    return {
      message: 'Could not save your changes. Please try again.',
      unresolvedExercises: [],
      retryable: true,
    };
  }

  const body = (error.body ?? {}) as UnresolvedBody;

  switch (error.status) {
    case 400: {
      const unresolved = Array.isArray(body.unresolved_exercises)
        ? body.unresolved_exercises.filter((name): name is string => typeof name === 'string')
        : [];

      if (unresolved.length > 0) {
        return {
          message:
            unresolved.length === 1
              ? 'One exercise is not in the catalog. Pick a suggested name.'
              : 'Some exercises are not in the catalog. Pick suggested names.',
          unresolvedExercises: unresolved,
          retryable: true,
        };
      }

      // The bare validation refusal. Nest sends `message` as an array of
      // strings here, which renders as nothing useful unless it is joined.
      return {
        message: validationMessage(body.message),
        unresolvedExercises: [],
        retryable: true,
      };
    }

    case 404:
      return {
        message: 'This workout no longer exists. Nothing was saved.',
        unresolvedExercises: [],
        retryable: false,
      };

    case 409:
      return {
        message:
          typeof body.message === 'string'
            ? body.message
            : 'This workout can no longer be edited. Nothing was saved.',
        unresolvedExercises: [],
        retryable: false,
      };

    case 503:
      return {
        message: 'The service is unavailable right now. Nothing was saved — try again in a moment.',
        unresolvedExercises: [],
        retryable: true,
      };

    default:
      return {
        message: 'Could not save your changes. Please try again.',
        unresolvedExercises: [],
        retryable: true,
      };
  }
}

function validationMessage(message: unknown): string {
  if (Array.isArray(message)) {
    const lines = message.filter((line): line is string => typeof line === 'string');
    if (lines.length > 0) return `${lines.join('; ')}.`;
  }
  if (typeof message === 'string' && message.trim() !== '') return message;
  return 'Some of this workout is not something the system can store.';
}
