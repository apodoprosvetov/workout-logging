import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

/**
 * Turn the raw rows an `UPDATE ... RETURNING` produces into entity-shaped
 * objects.
 *
 * `RETURNING` bypasses TypeORM's hydration entirely: `execute()` hands back
 * whatever the driver returned, keyed by **database column name**. With
 * `SnakeNamingStrategy` (db/typeorm.ts) that means `performed_at`, not
 * `performedAt`. Two things that look like they should solve this do not, both
 * checked rather than assumed:
 *
 * - `UpdateResult.generatedMaps` stays empty for an UPDATE.
 * - `manager.create(Entity, row)` expects *property* names, so given column
 *   names it silently returns `{}` — no error, no warning. That empty object is
 *   still truthy, so an `if (result)` guard passes and the failure only surfaces
 *   later as `undefined.toISOString()`, swallowed by whatever catch is nearest.
 *
 * The mapping comes from TypeORM's own column metadata rather than a
 * snake-to-camel rule. A rule is right until someone writes
 * `@Column({ name: 'performedAtUtc' })`, and then it is wrong in exactly the
 * same silent way. Metadata cannot disagree with the entity, because it *is*
 * the entity.
 *
 * Two shapes, matching the two shapes of `RETURNING`:
 *
 * - `mapReturning(...)` / `mapReturningOne(...)` take the same column list the
 *   statement asked for, and give back exactly those properties — `Pick<E, K>`,
 *   not `Partial<E>`, so a caller needs no guard for fields it knows are there.
 * - `mapReturningAll(...)` is for `RETURNING *`, and gives a whole entity.
 */
function mapRow<Entity extends ObjectLiteral>(
  manager: EntityManager,
  target: EntityTarget<Entity>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const column of manager.connection.getMetadata(target).columns) {
    // Only columns the statement actually returned — a partial RETURNING must
    // not invent `undefined` properties a caller could read as "present but
    // empty".
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
 * Map the rows of a `RETURNING [columns]` statement.
 *
 * Pass the *same* list the query asked for — sharing one `as const` array
 * between `.returning()` and this call is what keeps the type honest, and stops
 * the two drifting into disagreement.
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
 * Map the rows of a `RETURNING *` statement into whole entities.
 *
 * Separate from the picked form because the guarantee is different: here every
 * column is present, so the result is `Entity` and callers need no per-field
 * checks. Verified at runtime rather than asserted — a row missing columns means
 * the statement was not really `*`, and silently handing back a half-entity
 * typed as a whole one is the failure this module exists to prevent.
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
