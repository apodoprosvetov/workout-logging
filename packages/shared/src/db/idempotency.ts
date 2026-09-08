import { DataSource, EntityManager } from 'typeorm';

import { ProcessedEvent } from '../entities';
import { isUniqueViolation } from './pg-errors';

export type IdempotentResult<T> = { alreadyProcessed: true } | { alreadyProcessed: false; result: T };

// Idempotent event processing (research.md #4): insert event_id first — a
// conflict means this event was already handled, so `work` (and any non-
// Postgres side effects it performs, e.g. a Claude call) never runs again.
// Everything runs in one transaction, so a failed `work` rolls the insert
// back too — the event is free to be retried (research.md #3 / T032).
export async function withEventIdempotency<T>(
  dataSource: DataSource,
  eventId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<IdempotentResult<T>> {
  return dataSource.transaction(async (manager): Promise<IdempotentResult<T>> => {
    try {
      await manager.insert(ProcessedEvent, { eventId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { alreadyProcessed: true };
      }
      throw err;
    }
    const result = await work(manager);
    return { alreadyProcessed: false, result };
  });
}
