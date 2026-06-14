# Poll-Driven CI Build/Test Loop

## Goal

Let the coordination server run a one-week unattended CI/CD service: it polls a `build_requests` table in Supabase, and for each request it hard-resets a dedicated CI worktree to a named GitHub branch, runs the named build or test action, and writes the structured result back to the row. The operator (away from the machine, running Claude Code on a laptop) pushes a branch to GitHub and inserts one request row — no containers, no Claude Code agent, no OAuth on the host.

## Context

- The host-side build/test executor already exists in [server/src/routes/build.ts](../server/src/routes/build.ts). `POST /build` and `POST /test` already: sync a worktree, run the project's build/test script under a tree-kill timeout via `runTrackedBuild`, track the child in the in-memory `build-registry`, record a `build_history` row via `recordBuildStart` / `recordBuildEnd`, and return `{ success, exit_code, output, stderr }`. This plan adds a *pull* trigger in front of that machinery; it does not reinvent the build itself.
- The database is already Supabase (post-cutover), reached via `SCAFFOLD_DATABASE_URL` resolved by [server/src/db-env.ts](../server/src/db-env.ts). `build_history` and all coordination tables already live there. The laptop can insert rows directly through the Supabase MCP.
- **Why a dedicated CI worktree, not the existing staging path:** the current `syncWorktree` in [server/src/routes/build.ts](../server/src/routes/build.ts) fetches from the project's *bare repo*, which is itself fed only from the host's local working tree by `syncExteriorToBareRepo` ([server/src/routes/sync.ts](../server/src/routes/sync.ts)). Nothing in that path ever fetches from GitHub. The bare-repo / agent-branch machinery exists to isolate concurrent container agents; during the remote week there are zero agents, so this plan bypasses it entirely and operates on one git worktree whose `origin` is GitHub.
- **Canonical directions (stated once, referenced by every phase):**
  - *Reset direction:* the CI worktree is forced to match GitHub. Each request does `git fetch origin <branch>` then `git reset --hard FETCH_HEAD` — host-side working-tree state is discarded in favour of the remote tip, never the reverse. The host never pushes during a CI request.
  - *Claim order:* the loop claims the **oldest** pending request first — `ORDER BY created_at ASC, id ASC`.
  - *In-flight guard:* the loop runs a request only when idle. While a build is in flight the guard skips the tick. One request executes at a time.
- **GitHub credential — non-interactive, read-only, fail-fast.** The loop only ever *fetches* from GitHub, so a read-only credential suffices and minimizes the blast radius of a secret on an unattended host. Provision the CI worktree's `origin` to authenticate with no human in the loop and no expiry-driven re-auth: a passphraseless read-only SSH deploy key (`git@github.com:…`) is the gold standard; a fine-grained PAT scoped to Contents-read with expiry past the trip is the HTTPS equivalent. **Avoid an HTTPS remote backed by Git Credential Manager in OAuth mode** — its token can lapse mid-week and trigger an interactive browser sign-in, the exact unattended-auth trap this whole design exists to avoid. Every git invocation in this loop runs with `GIT_TERMINAL_PROMPT=0` (and, for SSH, `BatchMode=yes`) so any credential that *would* go interactive fails in milliseconds into a clean `error` status instead of hanging and wedging the in-flight guard for the rest of the week.
- **UBT lock is deliberately not used by this loop.** The `ubt_lock` row is a coordination token *between agents*; with zero agents there is nothing to coordinate. Cross-process safety against a stray operator/IDE build holding the OS-level UBT mutex is still covered, because reusing the executor inherits its process-level contention retry (`runWithUbtRetry` / `isUbtContentionResult` in [server/src/routes/build.ts](../server/src/routes/build.ts)). The single-in-flight guard provides the within-loop serialization.
- Out of scope: remote container launch, remote git merge/push, arbitrary remote shell, dashboard UI for the queue, and any auth layer on port 9100 (the loop is outbound-only to Supabase; the host exposes no new inbound surface).

<!-- PHASE-BOUNDARY -->

## Phase 1 — `build_requests` table, migration, and queries

**Outcome:** A `build_requests` table exists in the Drizzle schema with a generated migration that applies cleanly to both PGlite and Supabase. A queries module can create a request, atomically claim the oldest pending request, and finalize a request with its result. `npm run typecheck` is clean and the new query unit tests pass against an in-memory PGlite.

**Types / APIs:**

New table in [server/src/schema/tables.ts](../server/src/schema/tables.ts), matching the existing `buildHistory` declaration style (serial PK, `text` project FK, `jsonb`, `integer`-as-boolean for `success`):

```ts
export const buildRequests = pgTable(
  "build_requests",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    branch: text("branch").notNull(),
    operation: text("operation").notNull(), // 'build' | 'test'
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"), // 'pending'|'running'|'done'|'error'
    success: integer("success"),            // null until finalized; 1/0 once a script ran
    exitCode: integer("exit_code"),
    output: text("output"),
    stderr: text("stderr"),
    buildHistoryId: integer("build_history_id").references(() => buildHistory.id),
    createdAt: timestamp("created_at").defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    check("build_requests_operation_check", sql`${table.operation} IN ('build', 'test')`),
    check("build_requests_status_check", sql`${table.status} IN ('pending', 'running', 'done', 'error')`),
    index("idx_build_requests_status").on(table.status),
  ],
);
```

New queries module `server/src/queries/build-requests.ts`:

```ts
export interface BuildRequestRow { /* typeof buildRequests.$inferSelect */ }

export interface CreateBuildRequestInput {
  projectId: string;
  branch: string;
  operation: "build" | "test";
  params?: Record<string, unknown>;
}

/** Insert a pending request. Returns the new row. */
export async function createRequest(db: DbOrTx, input: CreateBuildRequestInput): Promise<BuildRequestRow>;

/**
 * Atomically claim the oldest pending request: set status='running', startedAt=now(),
 * and return it. Returns null when nothing is pending. Single-statement claim using
 * the same DELETE/SELECT-subquery pattern as `dequeue` in queries/ubt.ts, but as an
 * UPDATE ... WHERE id = (SELECT id ... WHERE status='pending' ORDER BY created_at ASC,
 * id ASC LIMIT 1) RETURNING *.
 */
export async function claimNextRequest(db: DbOrTx): Promise<BuildRequestRow | null>;

/** Finalize a request that ran: status='done', success/exitCode/output/stderr/buildHistoryId, completedAt=now(). */
export async function completeRequest(db: DbOrTx, id: number, result: {
  success: boolean; exitCode: number; output: string; stderr: string; buildHistoryId: number | null;
}): Promise<void>;

/** Finalize a request that could not run (unknown project, fetch failure, etc.): status='error', stderr=message, completedAt=now(). */
export async function failRequest(db: DbOrTx, id: number, message: string): Promise<void>;
```

**Work:**
- Add the `buildRequests` table to [server/src/schema/tables.ts](../server/src/schema/tables.ts) after `buildHistory` (it references `buildHistory.id`, so it must be declared after it). Keep the `// N. build_requests` numbered comment convention.
- Generate the migration with the project's existing Drizzle generate command (`npm run --prefix server db:generate` or the script the repo uses — confirm in `server/package.json`), producing the next-numbered file under [server/drizzle/](../server/drizzle/). Do not hand-write the SQL; let Drizzle emit it, then read it back to confirm it creates the table, both CHECK constraints, and the index.
- Create `server/src/queries/build-requests.ts` per the signatures above. Use `DbOrTx` from [server/src/drizzle-instance.ts](../server/src/drizzle-instance.ts). Implement `claimNextRequest` as a single atomic SQL statement (mirror the `dequeue` raw-SQL approach in [server/src/queries/ubt.ts](../server/src/queries/ubt.ts)) so two ticks can never claim the same row.
- Add `server/src/queries/build-requests.test.ts` covering: create→claim returns it and flips status to `running`; a second `claimNextRequest` with one pending and one running returns only the pending one; claim on an empty/all-running table returns null; two sequential claims hand back rows in `created_at` order (oldest first); `completeRequest` and `failRequest` set the terminal status and timestamps.

**Verification:**
- `npm run --prefix server typecheck` clean.
- `npx tsx --test server/src/queries/build-requests.test.ts` passes.
- Apply the migration to a throwaway PGlite (`db:migrate` with no `SCAFFOLD_DATABASE_URL`) and confirm `build_requests` exists with the two CHECK constraints and the status index.

<!-- PHASE-BOUNDARY -->

## Phase 2 — Decouple the tracked-script executor from the HTTP request

**Outcome:** The build/test script execution core is callable without a `FastifyRequest`. `POST /build` and `POST /test` behave exactly as before (same responses, same disconnect-reaping, same `build_history` rows), now by calling the extracted function. All existing build-route tests still pass.

**Types / APIs:**

Extract from [server/src/routes/build.ts](../server/src/routes/build.ts) into an exported function (either a new `server/src/build-exec.ts` or an export added to `build.ts` — engineer's call, but it must not import `fastify`):

```ts
export interface TrackedScriptInput {
  command: string;          // interpreter or script, from resolveScript()
  scriptArgs: string[];
  cwd: string;
  timeoutMs: number;
  projectId: string;
  agentLabel: string;       // 'build_history.agent' value; e.g. 'ci' for the loop, agent name for HTTP
  type: "build" | "test";
  retryCount: number;
  retryDelayMs: number;
  /**
   * Optional cooperative-cancel hook. The HTTP routes pass a registrar that wires
   * request.raw.on("close") to kill the process tree if the client disconnects.
   * The CI loop passes nothing (no client to disconnect).
   */
  onSpawned?: (child: import("node:child_process").ChildProcess) => () => void;
}

export interface TrackedScriptResult {
  success: boolean; exit_code: number; output: string; stderr: string; histId: number;
}

/** recordBuildStart -> runWithUbtRetry(runCommand + build-registry register) -> recordBuildEnd. */
export async function runTrackedScript(input: TrackedScriptInput): Promise<TrackedScriptResult>;
```

**Work:**
- Move the body of the current `runTrackedBuild` plus the surrounding `recordBuildStart` / `recordBuildEnd` calls into `runTrackedScript`. Replace the `request: FastifyRequest` parameter and its `request.raw.on("close", onClose)` / `off` wiring with the optional `onSpawned` registrar that returns a teardown function; the route supplies a registrar that performs today's disconnect-reap, preserving current behavior precisely.
- Keep `runCommand`, `runWithUbtRetry`, `isUbtContentionResult`, `resolveScript`, `buildTestScriptArgs`, and the `SCAFFOLD_FORWARD_SCRIPT` recursion guard exactly as-is — only the request coupling moves.
- Rewrite the `/build` and `/test` handlers to call `runTrackedScript`, passing an `onSpawned` that registers the `request.raw` close handler. Their `prepareBuildOrTest` preamble (agent header validation, `checkLock`, `syncWorktree`, `ensureStagingPlugins`) is unchanged — it stays in the route, not in the extracted core.

**Verification:**
- `npm run --prefix server typecheck` clean.
- The existing route tests pass unchanged: `npx tsx --test server/src/routes/build.test.ts` and `server/src/routes/build.e2e-test.ts`.
- Manual: with the dev server running, `POST /build` against a configured project still returns the structured result and still writes a `build_history` row.

<!-- PHASE-BOUNDARY -->

## Phase 3 — CI worktree sync and single-request runner

**Outcome:** A function that, given a project and a branch, hard-resets that project's dedicated CI worktree to the branch's GitHub tip and runs the named operation through `runTrackedScript`, returning the structured result plus the `build_history` id. Config carries where each project's CI worktree lives. No polling yet — this is the unit the loop will call.

**Types / APIs:**

Config additions in [server/src/config.ts](../server/src/config.ts):
- `ScaffoldConfig.server.ciWorktreeRoot?: string` — parent dir; a project's worktree defaults to `path.join(ciWorktreeRoot, projectId)`.
- `ProjectConfig.ciWorktreePath?: string` — explicit per-project override of the above.
- Resolution helper `getCiWorktree(config, projectId, project): string` returning the explicit path or the root-joined default; throws a clear error if neither is configured.

New module `server/src/ci-runner.ts`:

```ts
/** git fetch origin <branch>; git reset --hard FETCH_HEAD; git clean -fd. Throws on any git failure. */
export async function ciSyncWorktree(worktreePath: string, branch: string): Promise<void>;

export interface RunCiRequestInput {
  config: ScaffoldConfig;
  projectId: string;
  branch: string;
  operation: "build" | "test";
  params: Record<string, unknown>;
}

/** Resolve project + CI worktree, ciSyncWorktree, ensureStagingPlugins, resolve script + args, runTrackedScript. */
export async function runCiRequest(input: RunCiRequestInput): Promise<TrackedScriptResult>;
```

**Work:**
- Add a branch-name guard reused by `ciSyncWorktree`: reject anything not matching a conservative git-ref pattern (`/^[A-Za-z0-9._\/-]{1,200}$/` and no leading `-`, no `..`) before it reaches `git` args. Git calls already use `execFile`-style arg arrays (no shell), so this guards against malformed refs and surprising flags, not shell injection.
- Implement `ciSyncWorktree` with the project's git commands in the canonical reset direction: `git fetch origin <branch>` (network timeout ~60s), then `git reset --hard FETCH_HEAD`, then `git clean -fd`. Mirror `syncWorktree`'s pattern in [server/src/routes/build.ts](../server/src/routes/build.ts), including preserving gitignored build artifacts (`-d` without `-x`) so incremental UE builds reuse `Intermediate/` and `Binaries/`.
- Implement `runCiRequest`: resolve the project via [server/src/resolve-project.ts](../server/src/resolve-project.ts); resolve the CI worktree via `getCiWorktree`; call `ciSyncWorktree`; call `ensureStagingPlugins(cwd, config)` from [server/src/staging-plugins.ts](../server/src/staging-plugins.ts); pick `scriptPath` (build) or `testScriptPath` (test) with the same per-project / global fallback the routes use; build the argv with `["--summary", ...clean? ["--clean"]:[]]` for build and `buildTestScriptArgs(params, config.build.defaultTestFilters)` for test; pass `agentLabel: "ci"` and the project/global timeout to `runTrackedScript`.
- Update [server/src/config.ts](../server/src/config.ts) parsing (`parseProjectConfig` and the server block) and the `.env.example` / `scaffold.config.example.json` to document `ciWorktreeRoot` and `ciWorktreePath`.
- Add `server/src/ci-runner.test.ts` for the branch-name guard (accept/reject cases) and `getCiWorktree` resolution (explicit override, root-joined default, neither-configured throws). The git/script execution itself is covered by the Phase 5 E2E rather than mocked here.

**Verification:**
- `npm run --prefix server typecheck` clean.
- `npx tsx --test server/src/ci-runner.test.ts` passes.
- Manual: in a hand-prepared CI worktree clone, call `runCiRequest` once via a throwaway `tsx -e` script for a known branch and confirm the worktree HEAD matches `origin/<branch>` afterward and a `build_history` row is written.

<!-- PHASE-BOUNDARY -->

## Phase 4 — The poll loop

**Outcome:** On server startup a background loop claims the oldest pending `build_requests` row, runs it through `runCiRequest`, and finalizes the row — one request at a time, surviving individual request failures without crashing the loop or the server.

**Types / APIs:**
- Config: `ScaffoldConfig.server.ciPollIntervalMs?: number`, default `15_000` (coerced positive, same helper as the other timeouts).
- A module-level guard in the loop module: `let ciInFlight = false`.

**Work:**
- Add the loop in [server/src/index.ts](../server/src/index.ts) next to the existing `sweepStaleLock` `setInterval` (index.ts:186), using `config.server.ciPollIntervalMs`. Structure per tick:
  - If `ciInFlight`, return immediately (the in-flight guard — a build may run for hours; ticks must not stack or claim a second row).
  - `claimNextRequest(getDb())`; if null, return.
  - Set `ciInFlight = true`. In a `try/finally` that always clears `ciInFlight`: call `runCiRequest` with the claimed row's fields; on success `completeRequest(id, { success, exitCode, output, stderr, buildHistoryId })`; if `runCiRequest` throws (unknown project, fetch failure, git error — infrastructure, not a build failure) call `failRequest(id, message)`.
  - Wrap the whole tick so a thrown error is logged via `server.log.error` and never escapes the interval callback (match the `sweepStaleLock().catch(...)` treatment).
- Only the CI loop writes `build_requests`. It claims with `status='pending' -> 'running'` atomically, so even if a tick overlaps, a second claim cannot re-run the same row; the `ciInFlight` guard additionally guarantees only one build runs at a time.

**Worked example (claim order + guard):** queue has request A (created 09:00, status pending) and B (created 09:05, pending). Tick 1: `ciInFlight` is false → claim returns A (oldest by `created_at`), `ciInFlight=true`, A runs for 40 min. Ticks at 09:00:15, 09:00:30, … each see `ciInFlight=true` → skip. A finishes 09:40 → `completeRequest(A)`, `ciInFlight=false`. Next tick → claim returns B. Result: strict oldest-first, one at a time. If the guard polarity were inverted (run while busy / skip while idle), A and B would run concurrently and contend for the UE toolchain — the guard must skip when `ciInFlight` is true.

**Verification:**
- `npm run --prefix server typecheck` clean.
- Start the dev server; the startup banner is followed by no errors and the loop logs nothing when the queue is empty.
- Insert one `pending` row (via `createRequest` from a `tsx -e` snippet or the Supabase MCP) for a real project/branch; within `ciPollIntervalMs` the row goes `pending -> running -> done`, with `success`/`output`/`stderr`/`buildHistoryId` populated, and a matching `build_history` row exists.

<!-- PHASE-BOUNDARY -->

## Phase 5 — Operator setup, end-to-end run, and runbook entry

**Outcome:** The CI worktree is provisioned and the full remote loop is proven: a branch pushed to GitHub plus an inserted request row yields a real build/test result in the row, with the host running unattended. The operator runbook documents provisioning, inserting a request, and the unattended-host requirements.

**Types / APIs:** None.

**Work:**
- Provision the dedicated CI worktree once on the host: `git clone <github-url> <ciWorktreePath>` so its `origin` is GitHub; confirm `git -C <ciWorktreePath> remote get-url origin` points at GitHub and a `git -C <ciWorktreePath> fetch origin` succeeds with the host's stored credentials (so unattended fetches need no interactive auth). Set `server.ciWorktreeRoot` (or the per-project `ciWorktreePath`) in `scaffold.config.json`.
- E2E: from the laptop side of the workflow, push a trivial commit to a test branch on GitHub, then insert a `build_requests` row (`operation: "test"`, that branch, minimal `params`) via the Supabase MCP. Watch the row reach `done` and confirm `output` reflects the pushed commit's tree (e.g. a marker file or a deliberately failing test toggles `success`).
- Add an [Notes/operational-runbook.md](../Notes/operational-runbook.md) section "Remote CI build/test loop" covering: the canonical reset direction (worktree is forced to GitHub, host never pushes during a request); how to insert a request row and read its result columns; the single-in-flight, oldest-first semantics; and the unattended-host requirements — machine kept awake (no sleep/hibernate), the coordination server set to auto-start and auto-restart on crash/reboot, and the note that Docker need not run because no containers are involved.
- Confirm the loop's resilience to a server restart mid-build: a `running` row whose process died on restart is left non-terminal; document the manual recovery (re-set it to `pending` or insert a fresh request). Building automatic stale-`running` requeue is explicitly deferred.

**Verification:**
- A branch pushed to GitHub + an inserted request row produces a `done` row whose `success`/`output` match the pushed commit, with no host-side interaction.
- The server is restarted while idle and the loop resumes claiming on the next tick.
- The runbook section is present and names the unattended-host requirements.
