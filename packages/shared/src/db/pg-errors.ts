// Postgres unique_violation. Works for both a raw `pg` driver error and
// TypeORM's QueryFailedError wrapper (which nests it under driverError).
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}
