// Field names are snake_case: this is the JSON wire payload (contracts/events.md), not a JS object.

export const WORKOUT_EVENTS_EXCHANGE = 'workout.events';

export const WORKOUT_UPLOADED_ROUTING_KEY = 'workout.uploaded';
export const WORKOUT_PARSED_ROUTING_KEY = 'workout.parsed';

export const WORKOUT_PARSE_QUEUE = 'workout.parse.q';
export const WORKOUT_ANALYTICS_QUEUE = 'workout.analytics.q';
export const WORKOUT_DLQ = 'workout.dlq';

export const WORKOUT_DELETED_ROUTING_KEY = 'workout.deleted';
export const WORKOUT_UPDATED_ROUTING_KEY = 'workout.updated';

// Published by apps/api once the pending workout + raw upload are persisted.
export interface WorkoutUploadedEvent {
  event_id: string;
  user_id: string;
  workout_id: string;
  raw_upload_ref: string;
  occurred_at: string;
}

// Published by apps/worker's parser only for status = parsed | needs_review.
export interface WorkoutParsedEvent {
  event_id: string;
  user_id: string;
  workout_id: string;
  exercise_count: number;
  occurred_at: string;
}

// Published by apps/api after a workout is deleted, so the analytics worker can
// recompute the week it belonged to — nothing else invalidates that cache.
//
// `performed_at` and `user_id` are carried in the payload rather than looked up,
// because by the time this is consumed the row is gone.
export interface WorkoutDeletedEvent {
  // Discriminates this from WorkoutParsedEvent on the shared workout.analytics.q.
  //
  // A discriminator in the *body*, not the routing key, because the routing key
  // does not survive a retry: workout.analytics.q's retry tiers dead-letter with
  // `x-dead-letter-routing-key: workout.parsed` (they are named per primary
  // queue, not per event), so a redelivered deletion arrives claiming to be a
  // parse. Verified against the live broker. Same reasoning as
  // RETRY_ATTEMPT_HEADER: only the body crosses every hop unchanged.
  type: 'workout.deleted';
  event_id: string;
  user_id: string;
  workout_id: string;
  performed_at: string; // ISO 8601, UTC
  occurred_at: string;
}

// Published by apps/api after an edit, so the analytics worker can recompute
// both weeks it touches. `previous_performed_at` has to travel in the payload:
// after the commit the row reports only the new date, so the week the workout
// left is no longer derivable — same problem WorkoutDeletedEvent solves.
export interface WorkoutUpdatedEvent {
  // In the body, not the routing key — see WorkoutDeletedEvent above.
  type: 'workout.updated';
  event_id: string;
  user_id: string;
  workout_id: string;
  previous_performed_at: string; // ISO 8601, UTC — the week being left
  performed_at: string; // ISO 8601, UTC — the week being joined
  occurred_at: string;
}
