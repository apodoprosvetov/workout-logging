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
export const WORKOUT_UPDATED_KEY = 'workout.updated';
export const ANALYTICS_UPDATED_KEY = 'analytics.updated';

export type NotificationType =
  | typeof WORKOUT_SETTLED_KEY
  | typeof WORKOUT_CREATED_KEY
  | typeof WORKOUT_DELETED_KEY
  | typeof WORKOUT_UPDATED_KEY
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

// Not a workout.settled: apps/web reads a settle as extraction completing (it
// may move the dashboard's week and drains `loggedInThisTab`), and an edited
// workout was never in flight.
export interface WorkoutUpdatedNotification extends NotificationPayload {
  type: typeof WORKOUT_UPDATED_KEY;
  workout_id: string; // UUID
  // No date on purpose. An edit can move a workout between weeks, and every
  // week-scoped consumer drops a notification whose week is not the one on
  // screen — a dashboard showing the week the workout LEFT would keep listing
  // it. Carrying neither `performed_at` nor `iso_week` makes weekOf() null,
  // which already means "may concern any week".
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
  | WorkoutUpdatedNotification
  | AnalyticsUpdatedNotification;

// The channel format is defined here once, and read back here too — see
// getUserIdFromEventsChannel below. A subscriber that recovered the user id by
// splitting the string itself would be a second place that knows the format,
// and the two would drift silently: adding a segment (an environment, a
// version) would update this builder while the splitter kept returning the
// wrong piece, routing notifications to a user that does not exist. No error,
// no crash, just nobody receiving anything.
const EVENTS_CHANNEL_PREFIX = 'user-events:';

// One channel per user — and the channel name *is* the authorization boundary
// (FR-005): a subscriber only ever receives the users it asked for, so a leak
// across users would take a wrong channel name, not a missed filter. The colon
// follows the Redis namespacing this project already uses for
// `weekly_volume:{userId}:{isoWeek}`.
export function getEventsChannelName(userId: string): string {
  return `${EVENTS_CHANNEL_PREFIX}${userId}`;
}

/**
 * Recover the user id from a channel name, or `null` if it is not one of ours.
 *
 * The inverse of `getEventsChannelName`, deliberately kept beside it. Returns
 * `null` rather than a best guess so a caller subscribed to something
 * unexpected drops the message instead of delivering it to whoever the string
 * happened to parse into.
 */
export function getUserIdFromEventsChannel(channel: string): string | null {
  if (!channel.startsWith(EVENTS_CHANNEL_PREFIX)) return null;
  const userId = channel.slice(EVENTS_CHANNEL_PREFIX.length);
  return userId.length > 0 ? userId : null;
}
