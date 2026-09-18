import { describe, expect, it } from 'vitest';

import { ApiError } from '@services/api-client';

import { describeReplaceFailure } from './replace-failure';

describe('describeReplaceFailure', () => {
  it('names every unresolved exercise, not just the first', () => {
    const failure = describeReplaceFailure(
      new ApiError(400, {
        message: 'These exercises are not in the catalog.',
        unresolved_exercises: ['Bench Pres', 'Squatt'],
      }),
    );

    expect(failure.unresolvedExercises).toEqual(['Bench Pres', 'Squatt']);
    expect(failure.message).not.toBe('');
    expect(failure.retryable).toBe(true);
  });

  it('reads a bare validation refusal, whose message is an array', () => {
    const failure = describeReplaceFailure(
      new ApiError(400, {
        message: ['name must be shorter than 200 characters', 'exercises must not be empty'],
        error: 'Bad Request',
      }),
    );

    expect(failure.message).toContain('name must be shorter than 200 characters');
    expect(failure.message).toContain('exercises must not be empty');
    expect(failure.unresolvedExercises).toEqual([]);
  });

  it('still says something for a 400 with no readable body', () => {
    const failure = describeReplaceFailure(new ApiError(400, undefined));

    expect(failure.message.trim()).not.toBe('');
    expect(failure.message).not.toContain('[object Object]');
  });

  it('stops offering to save a workout that can no longer be edited', () => {
    const failure = describeReplaceFailure(
      new ApiError(409, { message: 'This workout can no longer be edited.' }),
    );

    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/no longer be edited/i);
  });

  it('stops offering to save a workout that is gone', () => {
    const failure = describeReplaceFailure(new ApiError(404, undefined));

    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/no longer exists/i);
  });

  it('reports a service failure as nothing saved, and keeps it retryable', () => {
    const failure = describeReplaceFailure(new ApiError(503, { message: 'nope' }));

    expect(failure.message).toMatch(/nothing was saved/i);
    expect(failure.retryable).toBe(true);
    expect(failure.unresolvedExercises).toEqual([]);
  });

  it('does not blame the user for a service failure', () => {
    const failure = describeReplaceFailure(new ApiError(503, { message: 'nope' }));

    expect(failure.unresolvedExercises).toEqual([]);
    expect(failure.message).not.toMatch(/catalog/i);
  });

  it('handles something that is not an ApiError at all', () => {
    const failure = describeReplaceFailure(new TypeError('network down'));

    expect(failure.message.trim()).not.toBe('');
    expect(failure.retryable).toBe(true);
  });

  it('gives every refusal a distinct, non-empty message', () => {
    const messages = [
      describeReplaceFailure(new ApiError(400, { unresolved_exercises: ['x'] })).message,
      describeReplaceFailure(new ApiError(400, { message: ['bad'] })).message,
      describeReplaceFailure(new ApiError(404, undefined)).message,
      describeReplaceFailure(new ApiError(409, undefined)).message,
      describeReplaceFailure(new ApiError(503, undefined)).message,
    ];

    expect(new Set(messages).size).toBe(messages.length);
    expect(messages.every((message) => message.trim() !== '')).toBe(true);
  });
});
