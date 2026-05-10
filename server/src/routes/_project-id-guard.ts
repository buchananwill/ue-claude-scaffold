/**
 * Shared `X-Project-Id` header guard for routes that must reject a missing
 * header with 400 rather than fall through to the project-id plugin's silent
 * default-to-`'default'`. Used by routes whose semantics demand explicit
 * project scoping (review ingestion, cross-task aggregations, failure
 * aggregations).
 *
 * The plugin in `server/src/plugins/project-id.ts` decorates
 * `request.projectId` with the validated header — but it substitutes
 * `'default'` when the header is absent, which silently scopes the request to
 * the wrong project. Routes that import this helper inspect the raw header
 * directly so a missing or empty header surfaces as 400.
 *
 * Headers can arrive as arrays when sent more than once on the same request
 * (Node's HTTP layer joins identically-named headers into an array). We
 * unpack the first element to match the project-id plugin's `[0]` behaviour
 * and to keep the asymmetry between routes from being a security pitfall.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Confirm that `X-Project-Id` was supplied. Empty / undefined → 400.
 *
 * @returns `true` when the request can proceed; `false` after sending a 400
 * (the caller must `return` immediately so Fastify does not double-reply).
 */
export function requireProjectIdHeader(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const raw = request.headers['x-project-id'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === '') {
    reply.badRequest('X-Project-Id header is required');
    return false;
  }
  return true;
}
