import { createLogger } from '@workout-logging/shared';

// Structured JSON logger for apps/worker (no Nest here). Import `log` and call
// `log.error('parse failed', { workout_id, err })` — never `console.*`.
export const log = createLogger('worker');
