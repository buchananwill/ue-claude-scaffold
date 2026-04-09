/**
 * Returns the first element of a query result array, or throws if empty.
 * Used after `.returning()` inserts where zero rows indicates an unexpected state.
 */
export function firstOrThrow<T>(rows: T[]): T {
  if (rows.length === 0) throw new Error('Insert returned no rows');
  return rows[0];
}
