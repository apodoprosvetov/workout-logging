// Field names are snake_case: this is the JSON wire payload (contracts/events.md), not a JS object.

export const WORKOUT_EVENTS_EXCHANGE = 'workout.events';

export const WORKOUT_UPLOADED_ROUTING_KEY = 'workout.uploaded';
export const WORKOUT_PARSED_ROUTING_KEY = 'workout.parsed';

export const WORKOUT_PARSE_QUEUE = 'workout.parse.q';
export const WORKOUT_ANALYTICS_QUEUE = 'workout.analytics.q';
export const WORKOUT_DLQ = 'workout.dlq';

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
