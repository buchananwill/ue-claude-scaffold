# Phase 2 — Server sessions route

Part of [Container Session Token Tracking](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** Three endpoints exist and respond correctly:
- `POST /sessions` — inserts a `running` record, returns `{ id: string }` (UUID).
- `PATCH /sessions/:id` — updates token counts, status, and raw output; returns the updated row.
- `GET /sessions` — returns an array of session records filtered by optional query params.

**Types / APIs:**

```typescript
// POST /sessions body
interface CreateSessionBody {
  agentId: string;       // UUID — must match a registered agent in this project
  taskId?: number | null;
}

// PATCH /sessions/:id body (all fields optional)
interface UpdateSessionBody {
  status?: 'complete' | 'aborted' | 'stopped';
  exitCode?: number;
  endedAt?: string;      // ISO 8601 UTC — stored as `timestamp` (without time zone)
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  rawOutput?: Record<string, unknown>; // stored as jsonb
}

// GET /sessions query params
interface SessionsQuery {
  agentId?: string;
  taskId?: string;       // numeric string, parsed to integer
  status?: string;
  limit?: string;        // default 100, max 500
}
```

**Work:**
- Create `server/src/routes/sessions.ts` exporting a `FastifyPluginAsync` as default. Follow the same plugin shape as `server/src/routes/builds.ts` or `server/src/routes/files.ts` for reference.
- `POST /sessions`: resolve project via `resolveProject`; validate `agentId` is a UUID belonging to the project; insert a row with `crypto.randomUUID()` as `id`, `status = 'running'`, `startedAt = new Date()`; return `201` with `{ id }`.
- `PATCH /sessions/:id`: look up session by `id` and `projectId`; return `404` if not found; apply only the fields present in the body; return `200` with the updated row. Do not allow a re-patch from `complete`/`aborted`/`stopped` back to `running`. When the body sets `status` to a terminal value (`complete`/`aborted`/`stopped`) and `endedAt` is not supplied, the server stamps `endedAt = new Date()` itself — container clocks are not trusted as the authoritative finalize time, and the helper in Phase 3 deliberately omits `endedAt` from its payload.
- `GET /sessions`: filter by `projectId` (always applied from header), plus optional `agentId`, `taskId`, `status`. Default `limit = 100`, max `500`. Return array ordered by `startedAt DESC`.
- Add `export { default as sessionsPlugin } from './sessions.js';` to `server/src/routes/index.ts`.
- Add `import { sessionsPlugin } from './routes/index.js';` and `await server.register(sessionsPlugin);` to `server/src/index.ts` after `agentDefinitionsPlugin`.

**Verification:** `cd server && npm run typecheck` passes. Write [server/src/routes/sessions.test.ts](../../server/src/routes/sessions.test.ts) following the same `node:test` + Drizzle test-helper pattern as [server/src/routes/builds.test.ts](../../server/src/routes/builds.test.ts) and [server/src/routes/files.test.ts](../../server/src/routes/files.test.ts). Required test coverage:

1. `POST /sessions` inserts a `running` row with the supplied `agentId` and `taskId` (or null) and returns 201 + `{ id }` (UUID).
2. `POST /sessions` rejects an `agentId` that does not belong to the requesting `projectId` with 400 or 404.
3. `PATCH /sessions/:id` updates token counts, status, exitCode, endedAt, and rawOutput; returns 200 with the updated row.
4. `PATCH /sessions/:id` returns 404 when the session does not exist or belongs to a different project.
5. `PATCH /sessions/:id` rejects a regression from `complete`/`aborted`/`stopped` back to `running` (return 409 or 400).
6. `GET /sessions` returns rows ordered by `startedAt DESC`, filtered correctly by `agentId`, `taskId`, `status`, and the `X-Project-Id` header. Default `limit = 100`, max `500`.

Run `npx tsx --test src/routes/sessions.test.ts` — all six cases must pass.
