# Server-Side Container Stop on Agent Delete

## Goal
Make the coordination server's `DELETE /agents/:name` endpoint actually stop the Docker container, so the dashboard trash-can button does what it claims.

## Context
The dashboard confirmation dialog says "This will signal the container to shut down," but the server only soft-deletes the DB record. The actual container stop lives in `stop.sh` which shells out to `docker compose down`. The server already uses `child_process.spawn` for builds in [build.ts](../server/src/routes/build.ts), so the pattern for shelling out from the server exists. The compose project name convention is `claude-{projectId}-{agentName}`, and the compose directory is `container/` relative to `configDir` (the repo root where `scaffold.config.json` lives).

The server runs on the host and has Docker access. Container self-deletion from inside Docker is not possible, but the server is always host-side, so this is the right place for the capability.

## Phase 1 — Compose-stop utility module

**Outcome:** A `server/src/compose-stop.ts` module exports a `stopContainer(projectId, agentName, configDir)` function that runs `docker compose --project-name claude-{projectId}-{agentName} down` and returns `{ ok: boolean; output: string }`. It auto-detects whether the host has `docker compose` (V2 plugin) or `docker-compose` (standalone). If neither is available, it returns `{ ok: false, output: 'docker compose not found' }` without throwing.

**Types / APIs:**

```ts
// server/src/compose-stop.ts

interface ComposeStopResult {
  ok: boolean;
  output: string;
}

function stopContainer(
  projectId: string,
  agentName: string,
  configDir: string,
): Promise<ComposeStopResult>;
```

- `configDir` comes from `ScaffoldConfig.configDir`. The compose directory is `path.join(configDir, 'container')`.
- The compose project name is `claude-${projectId}-${agentName}`.
- Use `spawn` (not `execSync`) with a 30-second timeout to avoid blocking the event loop.
- Detect compose variant by trying `docker compose version` first (spawn, check exit code 0), falling back to `docker-compose --version`. Cache the result in a module-level variable so detection runs once per process.

**Work:**
- Create [server/src/compose-stop.ts](../server/src/compose-stop.ts) with `stopContainer` and the compose detection helper.
- Create [server/src/compose-stop.test.ts](../server/src/compose-stop.test.ts) with unit tests. Mock `child_process.spawn` to avoid needing Docker in CI. Test cases: compose V2 detected and `down` succeeds, compose V2 not found but standalone found, neither found returns `ok: false`, spawn timeout returns `ok: false`.

**Verification:** `npx tsx --test server/src/compose-stop.test.ts` passes.

## Phase 2 — Wire stopContainer into DELETE /agents/:name

**Outcome:** `DELETE /agents/:name` performs the existing soft-delete transaction, then fires `stopContainer` as a best-effort side effect. The endpoint returns the same `{ ok: true, deleted: true }` shape it does today, with an added `containerStopped: boolean` field indicating whether Docker actually responded. A failed container stop does not change the HTTP status code — the DB deletion is the authoritative action; the container stop is best-effort.

**Types / APIs:**

The response shape becomes:
```ts
{ ok: true; deleted: true; containerStopped: boolean }
```

The `stopContainer` call uses `request.projectId` and the agent `name` from params, plus `config.configDir`.

**Work:**
- Import `stopContainer` from [compose-stop.ts](../server/src/compose-stop.ts) into [agents.ts](../server/src/routes/agents.ts).
- After the existing `db.transaction(...)` block in the `DELETE /agents/:name` handler, call `stopContainer`. Await the result. Include `containerStopped: result.ok` in the response.
- Log a warning via `fastify.log.warn` if `stopContainer` returns `ok: false`, including the output string for diagnostics.
- Do NOT wire this into `DELETE /agents` (bulk delete). Bulk delete is an operator action that pairs with `stop.sh`; adding implicit container stops to a bulk DB operation would be surprising and slow.

**Verification:** `npx tsx --test server/src/routes/agents.test.ts` passes. Existing tests still see `{ ok: true, deleted: true }` (the new field is additive). Add one new test that verifies `containerStopped` appears in the response (mock `stopContainer` at the module level to avoid needing Docker).

## Phase 3 — Update dashboard confirmation text

**Outcome:** The dashboard popover text accurately describes what the button does, and the response feedback reflects the container-stop result.

**Work:**
- In [AgentsPanel.tsx](../dashboard/src/components/AgentsPanel.tsx), the confirmation text on line 85 already says "Stop and deregister {a.name}? This will signal the container to shut down." — this is now accurate after Phase 2. No text change needed.
- Update `handleDelete` to read `containerStopped` from the response. If `containerStopped` is `false`, show a Mantine notification (warning color) saying the agent was deregistered but the container may still be running — suggest `./stop.sh --agent {name}`.
- If `containerStopped` is `true`, no extra notification needed (the existing query invalidation removes the agent from the list, which is sufficient feedback).

**Verification:** Start the dashboard dev server, click the trash button on a registered agent, confirm the popover, observe the notification behavior. With no Docker container running, the warning notification should appear. With a live container, it should stop and no warning should appear.
