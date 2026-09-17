import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

/**
 * Turn the raw rows of an `UPDATE ... RETURNING` into entity-shaped objects.
 *
 * `RETURNING` bypasses TypeORM's hydration: rows come back keyed by **database
 * column name** (`performed_at`, not `performedAt`). Neither obvious fix works,
 * both checked: `generatedMaps` stays empty for an UPDATE, and
 * `manager.create(Entity, row)` expects property names — given column names it
 * silently returns `{}`, which is truthy, so the failure surfaces much later as
 * `undefined.toISOString()`.
 *
 * Mapping comes from column metadata, not a snake-to-camel rule: a rule breaks
 * silently the same way the moment someone writes `@Column({ name: ... })`.
 */
function mapRow<Entity extends ObjectLiteral>(
  manager: EntityManager,
  target: EntityTarget<Entity>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const column of manager.connection.getMetadata(target).columns) {
    // Only what the statement returned: a partial RETURNING must not invent
    // `undefined` properties a caller could read as present-but-empty.
    if (column.databaseName in row) {
      mapped[column.propertyName] = row[column.databaseName];
    }
  }
  return mapped;
}

function asRows(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

/**
 * Pass the *same* column list the query asked for — sharing one `as const`
 * array between `.returning()` and this call is what keeps the type honest.
 *
 * @example
 * const COLUMNS = ['userId', 'performedAt'] as const;
 * const result = await qb.returning([...COLUMNS]).execute();
 * const rows = mapReturning(manager, Workout, result.raw, COLUMNS);
 * rows[0].performedAt; // Date — no guard, no cast
 */
export function mapReturning<Entity extends ObjectLiteral, Key extends keyof Entity>(
  manager: EntityManager,
  target: EntityTarget<Entity>,
  raw: unknown,
  columns: readonly Key[],
): Pick<Entity, Key>[] {
  void columns; // present for the type, not the runtime: metadata drives the mapping
  return asRows(raw).map((row) => mapRow(manager, target, row) as Pick<Entity, Key>);
}

/** The single-row case — what a guarded `UPDATE ... WHERE id = ?` produces. */
export function mapReturningOne<Entity extends ObjectLiteral, Key extends keyof Entity>(
  manager: EntityManager,
  target: EntityTarget<Entity>,
  raw: unknown,
  columns: readonly Key[],
): Pick<Entity, Key> | null {
  return mapReturning(manager, target, raw, columns)[0] ?? null;
}

/**
 * `RETURNING *` → whole entities. Separate from the picked form because the
 * guarantee differs: every column is present, so callers need no per-field
 * checks. Verified at runtime — handing back a half-entity typed as a whole one
 * is the failure this module exists to prevent.
 */
export function mapReturningAll<Entity extends ObjectLiteral>(
  manager: EntityManager,
  target: EntityTarget<Entity>,
  raw: unknown,
): Entity[] {
  const columns = manager.connection.getMetadata(target).columns;

  return asRows(raw).map((row) => {
    const missing = columns.filter((column) => !(column.databaseName in row));
    if (missing.length > 0) {
      throw new Error(
        `mapReturningAll: row is missing ${missing.map((c) => c.databaseName).join(', ')} — ` +
          `use mapReturning with an explicit column list for a partial RETURNING`,
      );
    }
    return mapRow(manager, target, row) as Entity;
  });
}
