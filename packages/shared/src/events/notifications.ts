import { WorkoutStatus } from '../entities';

// The statuses a workout can have *once processing is over* — the whole meaning
// of "settled". `pending` is excluded deliberately: a pending workout has not
// settled, so a settled notification carrying it would be a contradiction the
// type system should refuse rather than something a consumer has to guard.
//
// Narrower than WorkoutStatus, and on purpose: apps/web decides which surface a
// workout belongs to from exactly this value — `failed` stays in the in-flight
// modal until dismissed (FR-014), the other two move to the lists (FR-009).
export type SettledWorkoutStatus = Exclude<WorkoutStatus, WorkoutStatus.PENDING>;

export const WORKOUT_SETTLED_KEY = 'workout.settled';
export const WORKOUT_CREATED_KEY = 'workout.created';
export const WORKOUT_DELETED_KEY = 'workout.deleted';
export const ANALYTICS_UPDATED_KEY = 'analytics.updated';

export type NotificationType =
  | typeof WORKOUT_SETTLED_KEY
  | typeof WORKOUT_CREATED_KEY
  | typeof WORKOUT_DELETED_KEY
  | typeof ANALYTICS_UPDATED_KEY;

// Every notification shares this shape. Field names are snake_case: this is a JSON
// wire payload, consistent with the existing event contracts.
export type NotificationPayload = {
  // The discriminator lives in the body, and it is the only thing that
  // identifies a notification's kind: the Redis channel is per *user*
  // (getEventsChannelName), so every kind arrives on the same channel. A
  // subscriber that tried to infer the kind from where it arrived would have
  // nothing to go on.
  //
  // This also follows the rule the RabbitMQ side learned the hard way — see the
  // `isDeletion` comment in apps/worker/src/analytics/handler.ts, where a
  // redelivered deletion arrives claiming to be a parse because the retry tiers
  // dead-letter with a fixed routing key. Only the body crosses every hop
  // unchanged. Same conclusion, different transport.
  type: NotificationType;
  event_id: string; //UUID
  user_id: string; //UUID
  occurred_at: string; //ISO 8601, UTC
};

export interface WorkoutSettledNotification extends NotificationPayload {
  type: typeof WORKOUT_SETTLED_KEY;
  status: SettledWorkoutStatus;
  workout_id: string; // UUID
  performed_at: string; // ISO 8601, UTC
}

export interface WorkoutCreatedNotification extends NotificationPayload {
  type: typeof WORKOUT_CREATED_KEY;
  workout_id: string; // UUID
  performed_at: string; // ISO 8601, UTC
}

export interface WorkoutDeletedNotification extends NotificationPayload {
  type: typeof WORKOUT_DELETED_KEY;
  workout_id: string; // UUID
  performed_at: string; // ISO 8601, UTC
}

export interface AnalyticsUpdatedNotification extends NotificationPayload {
  type: typeof ANALYTICS_UPDATED_KEY;
  iso_week: string; // ISO key of the week that was updated, e.g. "2023-W01"
}

// What a publisher accepts and a subscriber receives. Discriminated on `type`,
// so narrowing a ChangeNotification in a switch gives the right extra fields
// (`iso_week` only on analytics.updated, `status` only on workout.settled) and
// makes an unhandled kind a compile error rather than a silent no-op.
export type ChangeNotification =
  | WorkoutSettledNotification
  | WorkoutCreatedNotification
  | WorkoutDeletedNotification
  | AnalyticsUpdatedNotification;

// One channel per user — and the channel name *is* the authorization boundary
// (FR-005): a subscriber only ever receives the users it asked for, so a leak
// across users would take a wrong channel name, not a missed filter. The colon
// follows the Redis namespacing this project already uses for
// `weekly_volume:{userId}:{isoWeek}`.
export function getEventsChannelName(userId: string): string {
  return `user-events:${userId}`;
}
