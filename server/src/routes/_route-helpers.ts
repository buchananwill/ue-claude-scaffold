/**
 * Shared parsing/validation helpers for the review-ingestion and cross-task
 * aggregation routes (`failures.ts`, `findings.ts`, `reviews.ts`). Each helper
 * is pure and free of Fastify route wiring; the only Fastify dependency is the
 * `parseSinceParam` wrapper that knows how to send a 400 reply.
 *
 * Centralising these helpers avoids drift between byte-for-byte duplicates in
 * the route files (the decomposition reviewer's B1/B2/W1/W2 findings on
 * Phase 3). The error-message strings are preserved verbatim so existing
 * tests continue to pass without modification.
 */
import type { FastifyReply } from 'fastify';

// ── `since` query param ────────────────────────────────────────────────────

/** Default trailing window for cross-task aggregations: 30 days. */
export const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse a `since` query parameter as an ISO date string. Returns the parsed
 * Date or the default (now − 30 days) when absent. Returns `null` when the
 * supplied value is non-empty but unparseable — the caller turns that into a
 * 400.
 */
export function parseSince(raw: string | undefined): Date | null {
  if (raw === undefined || raw === '') {
    return new Date(Date.now() - DEFAULT_SINCE_MS);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Parse `since` and short-circuit a 400 reply on failure. Use as:
 *
 *     const since = parseSinceParam(reply, q.since);
 *     if (since === null) return;
 *
 * Returns the parsed Date on success, or `null` after sending a 400 (the
 * caller must `return` immediately so Fastify does not double-reply).
 */
export function parseSinceParam(
  reply: FastifyReply,
  raw: string | undefined,
): Date | null {
  const since = parseSince(raw);
  if (since === null) {
    reply.badRequest('since must be an ISO 8601 date');
    return null;
  }
  return since;
}

// ── id-array normalisation ─────────────────────────────────────────────────

/**
 * Drivers vary in how they return Postgres array columns. node-postgres
 * returns a JS array; PGlite sometimes returns the Postgres text
 * representation `{1,2,3}`. Normalise both to `number[]`.
 */
export function normalizeIdArray(
  raw: number[] | string | null | undefined,
): number[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/^\{|\}$/g, '');
    if (trimmed.length === 0) return [];
    return trimmed.split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n));
  }
  return [];
}

// ── `db.execute(sql\`...\`)` row shape cast ────────────────────────────────

/**
 * Cast the result of `db.execute(sql\`...\`)` to the typed row array. The
 * three CTE-based aggregation endpoints all need this cast and the row shape
 * differs per call site, so the helper is generic over the row type.
 *
 * Usage: `const rows = rowsOf<MyRow>(result);`
 */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

// ── reviewer-role validation ───────────────────────────────────────────────

export const REVIEWER_ROLE_RE = /^[A-Za-z0-9_-]+$/;
export const REVIEWER_ROLE_MAX = 64;

/**
 * Validate the length and character set of a reviewer-role string against the
 * project-wide regex and length cap. Returns `null` when the value passes;
 * otherwise returns the human-readable error message the caller should send
 * as a 400.
 *
 * The `fieldName` parameter selects the wording used in the message —
 * `reviewerRole` for the POST body field, `reviewer` for the
 * `/findings?reviewer=...` query param.
 *
 * Callers that also need to reject the empty-string and wrong-type cases
 * (e.g. `POST /tasks/:id/reviews`) handle those checks before calling this
 * helper, since their error wording differs (`must be a non-empty string`
 * vs. just `must be non-empty`).
 */
export function reviewerRoleError(
  value: string,
  fieldName: 'reviewerRole' | 'reviewer' = 'reviewerRole',
): string | null {
  if (value.length > REVIEWER_ROLE_MAX) {
    return `${fieldName} exceeds maximum length of ${REVIEWER_ROLE_MAX}`;
  }
  if (!REVIEWER_ROLE_RE.test(value)) {
    return `${fieldName} must match /^[A-Za-z0-9_-]+$/`;
  }
  return null;
}

// ── unique-constraint conflict detection ───────────────────────────────────

/**
 * Detect whether a Drizzle insert error corresponds to a unique violation on
 * the named constraint. Both PG (node-postgres) and PGlite surface unique
 * violations with SQLSTATE 23505; the constraint name may appear on
 * `.constraint`, `.constraint_name`, or in the error message text. PGlite
 * sometimes wraps the underlying error, so we recurse through `.cause`.
 *
 * The fallback path (when neither `.constraint` nor `.constraint_name` is
 * populated) requires the message to mention the specific constraint name. A
 * blanket 23505/"unique" match would misreport conflicts on any future unique
 * index added to the same table as the watched conflict.
 *
 * Used by `reviews.ts` (review_runs_task_cycle_role_unique) and
 * `arbitrations.ts` (arbitration_runs_task_trigger_unique).
 */
export function isUniqueConstraintConflict(
  err: unknown,
  constraintName: string,
): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown> & { cause?: unknown };
  const code = e.code;
  const message = typeof e.message === 'string' ? e.message : '';
  const constraint =
    (typeof e.constraint === 'string' && e.constraint)
    || (typeof e.constraint_name === 'string' && e.constraint_name)
    || '';
  const matchesConstraint =
    constraint === constraintName
    || message.includes(constraintName);
  if (matchesConstraint) return true;
  if (e.cause) {
    return isUniqueConstraintConflict(e.cause, constraintName);
  }
  return code === '23505' && message.includes(constraintName);
}
