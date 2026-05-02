# Line Manager Watchdog

## Goal
Add a long-running, project-scoped oversight agent that detects continuity gaps between pump-task units — most importantly test failures rationalised away as "scoped to a previous phase" — without burning Opus tokens on idle watching. The container runs a cheap always-on driver process and summons a fresh `claude -p` Opus session only when a tripwire fires or the heartbeat clock elapses.

## Context

- Pump containers run `claude -p` per task with fresh context. Quality per task is high, but cross-task drift slips through — most importantly, test failures that one phase caused get rationalised away by a later phase as "out of scope" or "pre-existing", a pattern that gets worse when anomalous container shutdown and restart blurs the phase boundary. The watchdog also has to tolerate legitimate test-failure increases (TDD red-phase, deliberately failing tests committed before the implementation lands), so a raw failure-count delta is a *trigger for an audit*, not a finding on its own — corroborating evidence (commit messages, files touched, rationalisation language) is what promotes the trigger to a finding.
- Headless `claude -p` is request/response. Keeping a session "alive" between events would either burn tokens on heartbeats or waste the 5-minute prompt cache window. The watchdog is therefore not a long-running Claude session — it is a long-running driver process that summons short Opus sessions on signal.
- Haiku is **not** in the runtime path. Haiku is an upstream analysis tool the operator runs against the historical message corpus to surface candidate weasel phrases; the curated phrases land in a static matcher config. Runtime triage is regex/string matchers + numeric anomaly checks + (sometimes) Opus.
- Heartbeat fires Opus unconditionally — the point of the watchdog is to catch continuity gaps the matchers cannot articulate. The heartbeat clock measures "time since last Opus inspection of any kind", so a tripwire-triggered audit at minute 25 resets the clock and the next heartbeat fires 30 minutes after that, not at minute 30.
- The watchdog never pushes code. It has three escalation tiers, all driven through the driver — the LM itself only emits a JSON envelope:
  - **Tier-1 `note`** — driver posts a finding to the configured message-board channel via `POST /lm/findings`. Operator reads later.
  - **Tier-2 `pause`** — driver also calls `POST /coalesce/pause` for the project. Pumps stop until the operator resumes.
  - **Tier-3 `intervene`** — driver posts a chat-room message into the target agent's existing `CHAT_ROOM` (resolved server-side from `room_members`) via `POST /lm/interventions`. The targeted agent reads the message between sub-agent delegations and decides whether to factor in the corrected information. The LM provides the missing/incorrect information; the orchestrator decides the next action. This is the LM's principal value: most failures it catches are recoverable through dialogue rather than a hard halt, so `intervene` is preferred when the issue is information-shaped rather than safety-shaped.
- The intervention path uses infrastructure that already exists. The chat-channel MCP is mounted in every container by [`container/lib/post-setup.sh`](../container/lib/post-setup.sh). Each engineer container is launched with a `CHAT_ROOM` env var ([`container/docker-compose.template.yml`](../container/docker-compose.template.yml) line 27) and joins that room as a member during registration ([`container/lib/registration.sh`](../container/lib/registration.sh) line 187). What this plan adds: chat tools and an intervention-aware skill on the orchestrator agent definitions, and a thin server endpoint that posts into the target's existing room as `system` author type (operators and the LM driver bypass room membership; engineer agents must be members to read).
- Engineer containers communicate via the server message board (`POST /messages` / the `messages` table) and commit work to their `docker/{project-id}/{agent-name}` branches in the bare repo. The LM watches both surfaces for matcher/anomaly evidence. Chat rooms (`/rooms/*`) are not an evidence surface for the LM — engineers don't post status reports there — but the LM can post into a target agent's room when it needs to intervene.
- One watchdog container per project, lifecycle scoped to active work. The container starts when the operator launches a pump or worker for the project and shuts itself down when the project goes idle (no active or pending tasks, all pump agents idle, no inspection in flight) for a configured grace window. The watchdog therefore never runs while nothing is happening — there is no need to design around long-idle windows.
- Engineers' actual reasoning lives in their board messages (orchestrator debriefs, `phase_start` / `phase_complete` / `status_update` messages) and in commit messages on their branches; both feed the matcher pipeline equally.
- Triggers are one-shot per piece of evidence. The driver tracks cursors (last seen board message ID, last seen commit SHA per agent branch, last seen build ID — see Phase 4's `DriverCursors` for the canonical list) so a given matcher phrase, anomaly, or mention fires exactly once. There is no schema-level dedup on findings — the driver's cursors prevent the flood, and the LM's behavioural judgment handles the remaining edge cases (a window genuinely justifies a re-emit only when the LM decides so, e.g. severity escalation).
- A 30-minute heartbeat window with zero new evidence — no agent commits, no UE builds, no posted messages — is itself a red flag worth escalating. The LM must not return `quiet` on an empty window: an active project with no activity for half an hour is either stuck or hiding work, and that's a finding.
- The container can fetch any branch in the bare repo (`docker/{project-id}/current-root` plus every `docker/{project-id}/{agent-name}`) into its own throwaway worktrees for diff inspection.
- The watchdog can ask the server to email the operator out-of-band for findings the operator should see immediately — the server holds the Resend API key, the container does not. This keeps the container's outbound media surface as narrow as possible.
- Out of scope for this plan: the Haiku-assisted historical sweep tool (separate one-shot tooling); operator dashboard UI for findings (the existing message-board view already renders entries on the configured channel); promotion of the watchdog to a code-pushing role; pinging short-lived sub-agents (implementers, reviewers) — interventions only target persistent agents (orchestrators); notification channels other than email (SMS, Slack, push) — the email path is the v1 surface, additional channels are future plans.

<!-- PHASE-BOUNDARY -->

## Phase 1 — Schema additions for the watchdog

**Outcome:** The database persists every Opus inspection (so the heartbeat clock has a single source of truth across container restarts) and links each inspection to the message-board entry it produced, if any. Findings themselves live as `messages` rows with `type='lm_finding'` — there is no separate findings table.

**Types / APIs:**

In [`server/src/schema/tables.ts`](../server/src/schema/tables.ts):

```ts
export const lmInspections = pgTable('lm_inspections', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  triggerKind: text('trigger_kind').notNull(), // 'heartbeat' | 'matcher' | 'anomaly' | 'mention' | 'stale_window'
  triggerDetail: text('trigger_detail'),       // free text — e.g. matcher key, anomaly metric, source message ID
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  outcome: text('outcome').notNull(),          // 'quiet' | 'finding' | 'budget_exhausted' | 'error'
  producedMessageId: integer('produced_message_id').references(() => messages.id),
  // Set for board-board posts: 'finding' (note/pause severity), 'quiet' on heartbeat,
  // and 'budget_exhausted'. Null otherwise.
  producedChatMessageId: integer('produced_chat_message_id').references(() => chatMessages.id),
  // Set for chat-room posts: 'finding' with severity='intervene' (Phase 12).
  // produced_message_id and produced_chat_message_id are mutually exclusive on a
  // given inspection — enforced by the CHECK constraint below.
}, (table) => [
  check(
    'lm_inspections_produced_exclusive',
    sql`${table.producedMessageId} IS NULL OR ${table.producedChatMessageId} IS NULL`,
  ),
]);
```

Existing [`server/src/schema/tables.ts`](../server/src/schema/tables.ts) `build_history` gains two nullable columns:

```ts
// Additive on the existing build_history table — no other column changes.
testsRun: integer('tests_run'),       // populated only when type='test' AND
testsFailed: integer('tests_failed'), // the project's /test endpoint parsed counts.
// Both NULL when type='build', or when type='test' and the project has not opted
// in to test-count parsing (the parser is per-project; see issue/follow-up plan).
```

**Work:**

- Author one Drizzle migration under [`server/drizzle/`](../server/drizzle/) that adds `lm_inspections` (with the CHECK constraint above) and adds `tests_run` / `tests_failed` to `build_history`.
- Add the new table and the new columns to [`server/src/schema/tables.ts`](../server/src/schema/tables.ts).
- No findings table, no dedup_key, no severity column. Severity, title, body, and any auditor-specific structured data live on `messages.payload` for rows with `type='lm_finding'`. The audit-trail link inspection → message goes through `lm_inspections.produced_message_id` (board posts) or `produced_chat_message_id` (chat-room posts) — never both.
- The `tests_run` / `tests_failed` columns are added structurally now so Phase 5's `test_failure_count_increased` anomaly has a column to read from. Population is opt-in per project: each project's `/test` endpoint can parse its own runner output and write the counts. Projects that have not yet opted in leave both columns NULL, and Phase 5's anomaly silently skips the comparison for those projects.

**Verification:**

- `npm run db:migrate` succeeds against a fresh PGlite.
- `npx tsx --test server/src/schema/` passes.
- A fresh hand-written test inserts an inspection row, then a `messages` row with `type='lm_finding'`, sets `produced_message_id` on the inspection, and reads back the join.
- A second test attempts to set both `produced_message_id` and `produced_chat_message_id` on the same inspection row and confirms the CHECK constraint rejects it.
- A third test inserts a `build_history` row with `type='test'`, `tests_run=10`, `tests_failed=2`, and reads it back.

<!-- PHASE-BOUNDARY -->

## Phase 2 — Server endpoints the watchdog consumes

**Outcome:** The watchdog driver can ask the server for everything it needs in a single round-trip per inspection cycle, can record that an inspection happened (resetting the heartbeat clock), and can record a finding with de-duplication enforced server-side.

**Types / APIs:**

New plugin file [`server/src/routes/lm.ts`](../server/src/routes/lm.ts) registering four endpoints under the existing `X-Project-Id` scoping:

```ts
// GET /lm/window?since={ISO8601}
// Returns the activity bundle the watchdog audits over.
interface LmWindowResponse {
  cursor: { since: string; now: string };
  agents: Array<{ id: string; name: string; status: string; mode: string; branch: string }>;
  recentBoardMessages: Array<{
    id: number; channel: string; fromAgent: string; type: string;
    payload: unknown; createdAt: string;
  }>;
  // Commit text per agent branch is fetched by the driver from the bare repo
  // (Phase 4) — not by the server — because the bare repo is the authoritative
  // source for commit history. The window endpoint surfaces only what lives in
  // the database: board messages, tasks, and build/test results.
  recentTasks: Array<{
    id: string;
    status: string;
    claimedByAgentId: string | null; // FK to agents.id
    claimedByAgentName: string | null; // resolved via JOIN on agents
    claimedAt: string | null;
    completedAt: string | null;
    sourcePath: string | null;
  }>;
  recentBuilds: Array<{
    id: number;
    type: 'build' | 'test';
    success: boolean; // mapped from integer 0/1 in build_history
    agent: string;    // agent name at the time of the build
    startedAt: string;
    durationMs: number | null;
    testsRun: number | null;
    testsFailed: number | null;
  }>;
}

// POST /lm/inspections
interface RecordInspectionRequest {
  triggerKind: 'heartbeat' | 'matcher' | 'anomaly' | 'mention' | 'stale_window';
  triggerDetail?: string;
  startedAt: string;        // ISO8601
  finishedAt: string;       // ISO8601
  inputTokens: number;
  outputTokens: number;
  producedMessageId?: number; // set when the driver posted to the board (heartbeat-quiet, budget-exhausted)
  outcome: 'quiet' | 'finding' | 'budget_exhausted' | 'error';
}
interface RecordInspectionResponse { id: number; lastInspectionAt: string }

// POST /lm/findings
interface PostFindingRequest {
  inspectionId: number;
  severity: 'note' | 'pause';
  title: string;
  body: string;
  channel: string;          // message-board channel, e.g. 'lm-findings'
  notifyOperator: boolean;  // true => server emails the operator (rate-limited, Phase 9)
}
interface PostFindingResponse {
  messageId: number;        // ID of the messages row created with type='lm_finding'
  emailed: boolean;
  emailReason?: 'sent' | 'cooldown' | 'no_address' | 'no_api_key' | 'error' | 'not_requested';
}

// GET /lm/state
interface LmStateResponse {
  lastInspectionAt: string | null;          // null on first run
  tokensSpentTodayUtc: number;              // sum of input+output tokens for today (UTC midnight rollover)
  budgetTodayUtc: number;                   // configured daily cap; 0 means unlimited
  budgetExhausted: boolean;                 // tokensSpentTodayUtc >= budgetTodayUtc when budget > 0
}
```

**Work:**

- Register the plugin in [`server/src/routes/index.ts`](../server/src/routes/index.ts).
- `GET /lm/window` aggregates rows from the existing tables. The `since` query param defaults to "the latest `finishedAt` in `lmInspections` for this project, or now − 30 min if none". Each row collection (`recentBoardMessages`, `recentTasks`, `recentBuilds`) is bounded by `since` and a hard cap (200 rows each) so the bundle stays small. `recentBoardMessages` includes orchestrator debriefs, `phase_start` / `phase_complete` / `status_update` posts, prior LM findings, and any other agent output posted via `POST /messages`; the watchdog scans it for matcher hits alongside the commit messages it fetches directly from the bare repo (Phase 4), and uses prior LM findings as memory of what has already been flagged. Chat-room content is not surfaced — the LM does not match against `/rooms/*` traffic.
- `POST /lm/findings` posts to the server message board, mirroring how orchestrators post their debriefs. The route inserts a row into `messages` via `msgQ.insert` with `channel` from the request, `type='lm_finding'`, and `fromAgent` taken from the request's `X-Agent-Name` header (the watchdog sets this to its configured identity, e.g. `lm-watchdog`). The `payload` carries the structured finding (`severity`, `title`, `body`, `inspectionId`). After the message inserts, the route updates the corresponding `lm_inspections` row's `produced_message_id` to the new `messages.id`. No dedup check — the driver guarantees one trigger per piece of evidence (Phase 5).
- `GET /lm/state` reads the daily budget from project config (Phase 8) and sums tokens from today's `lmInspections` rows.

**Verification:**

- New test file [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts) using [`server/src/drizzle-test-helper.ts`](../server/src/drizzle-test-helper.ts) covers: window aggregation respects `since` and surfaces board messages, tasks, and builds (chat-room content is not surfaced); `recentBuilds` rows include `testsRun` and `testsFailed` when populated and `null` when unset; `recentTasks` rows include `claimedByAgentName` resolved via JOIN on `agents`; inspection insert returns the new row's ID and `lastInspectionAt` and accepts `triggerKind='stale_window'` and an optional `producedMessageId`; finding insert posts a message-board entry with `type='lm_finding'` and `fromAgent` matching the request's `X-Agent-Name` header; finding insert updates the inspection's `produced_message_id`; state reflects today's token sum.
- `npm test` green for the server package.

<!-- PHASE-BOUNDARY -->

## Phase 3 — Watchdog container service in compose

**Outcome:** `launch.sh` (or an equivalent invocation) can start a `lm-watchdog` container per project alongside the existing pump containers. The container starts, registers nothing on the agents table (the watchdog is not an agent — its identity is the `WATCHDOG_AGENT_IDENTITY` value sent as `X-Agent-Name` on every server request, which the message board records as `fromAgent` on each posted entry), and idles in its driver loop.

**Types / APIs:**

Additions to [`container/docker-compose.example.yml`](../container/docker-compose.example.yml):

```yaml
services:
  lm-watchdog:
    build:
      context: .
      dockerfile: Dockerfile.watchdog          # see Work
    environment:
      - PROJECT_ID=${PROJECT_ID:-default}
      - SERVER_URL=http://host.docker.internal:${SERVER_PORT:-9100}
      - WATCHDOG_HEARTBEAT_SECONDS=${WATCHDOG_HEARTBEAT_SECONDS:-1800}
      - WATCHDOG_POLL_SECONDS=${WATCHDOG_POLL_SECONDS:-30}
      - WATCHDOG_DAILY_TOKEN_BUDGET=${WATCHDOG_DAILY_TOKEN_BUDGET:-0}   # 0 = unlimited
      - WATCHDOG_DEFAULT_CHANNEL=${WATCHDOG_DEFAULT_CHANNEL:-lm-findings}
      - WATCHDOG_AGENT_IDENTITY=${WATCHDOG_AGENT_IDENTITY:-lm-watchdog}
      - WATCHDOG_AGENT_TYPE=${WATCHDOG_AGENT_TYPE:?Set WATCHDOG_AGENT_TYPE in .env (e.g. lm-watchdog-ue or lm-watchdog-scaffold)}
      - WATCHDOG_IDLE_SHUTDOWN_SECONDS=${WATCHDOG_IDLE_SHUTDOWN_SECONDS:-600}
      # Container exits cleanly after this many seconds of continuous project idle
      # (no active or pending tasks, all pump agents idle, no inspection in flight).
      - WATCHDOG_STALE_WINDOW_SECONDS=${WATCHDOG_STALE_WINDOW_SECONDS:-1800}
      # If a heartbeat fires and the window contains zero new evidence, the driver
      # treats this as a finding (the project is active but nothing has happened).
    volumes:
      - ${BARE_REPO_PATH:?Set BARE_REPO_PATH}:/repo.git:ro
      - ${LOGS_PATH:-./logs}:/logs
      - ${CLAUDE_CREDENTIALS_PATH:?Set CLAUDE_CREDENTIALS_PATH}:/home/claude/.claude/.credentials.json:ro
      - ${AGENTS_PATH:-../agents}:/staged-agents:ro
      - watchdog-workspace:/workspace
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: "no"

volumes:
  watchdog-workspace:
```

**Work:**

- Add a new [`container/Dockerfile.watchdog`](../container/Dockerfile.watchdog) layered on the existing container image. It installs Node ≥ 20 (already present), copies the driver source (Phase 4) under `/opt/watchdog`, and sets `ENTRYPOINT ["/opt/watchdog/entrypoint.sh"]`.
- Bare repo mount is **read-only**. The driver does its own `git clone /repo.git /workspace/repo` on first start so it has a writable working tree for `git fetch` + worktree creation, without ever pushing anything back.
- The watchdog does **not** call `POST /agents/register`. It identifies itself via the `X-Agent-Name` header (`WATCHDOG_AGENT_IDENTITY`) on every request, which the message board records as `fromAgent` on each posted entry. `WATCHDOG_AGENT_TYPE` is the agent definition slug used when invoking `claude -p` (Phase 6) and is independent of the identity header.
- Update [`scripts/launch-team.sh`](../scripts/launch-team.sh) and the relevant compose-detect helper in [`scripts/lib/compose-detect.sh`](../scripts/lib/compose-detect.sh) to recognise `lm-watchdog` as a known service. Launch path: `./launch.sh --watchdog` brings up only the watchdog service for the resolved project. The compose service uses `restart: "no"` — once the driver self-exits on idle, the container stays down until the operator launches it again alongside the next pump session.
- Container start-up steps in [`container/Dockerfile.watchdog`](../container/Dockerfile.watchdog)'s entrypoint: validate env, ensure `/workspace/repo` exists (clone if not), then `exec node /opt/watchdog/dist/main.js`.

**Verification:**

- `bash -n` clean on every modified shell script.
- Operator runs `./launch.sh --watchdog --dry-run` and observes a resolved compose file containing the new service with the correct env and volume mounts.
- Operator runs `./launch.sh --watchdog`, container starts, `docker logs` shows the driver entering its idle loop, and the container persists for at least one heartbeat interval. (See Phase 9 for the full smoke test.)

<!-- PHASE-BOUNDARY -->

## Phase 4 — Watchdog driver process

**Outcome:** A Node TypeScript process running inside the watchdog container loops, polling the server every `WATCHDOG_POLL_SECONDS`, fetches new commits from the bare repo for every active agent branch, applies triage rules (Phase 5), decides whether to invoke an audit (Phase 6), records the inspection via `POST /lm/inspections`, and posts findings via `POST /lm/findings`. The driver exits cleanly when the project has been idle for `WATCHDOG_IDLE_SHUTDOWN_SECONDS`. Durable state (heartbeat clock, token budget) lives on the server. Cursor state (last seen board message ID, last seen commit SHA per branch, last seen build ID, last seen task transition timestamp) lives in-memory on the driver — restart-safe because on restart the driver simply scans the window from the latest server-recorded inspection forward, and the LM's first audit on the new run sees the full bundle since then.

**Types / APIs:**

New TypeScript source tree under [`container/watchdog/`](../container/watchdog/):

```ts
// container/watchdog/src/main.ts
async function main(): Promise<void>;          // entrypoint; never returns

// container/watchdog/src/serverClient.ts
class ServerClient {
  constructor(opts: { baseUrl: string; projectId: string });
  getWindow(since: string): Promise<LmWindowResponse>;
  getState(): Promise<LmStateResponse>;
  recordInspection(req: RecordInspectionRequest): Promise<RecordInspectionResponse>;
  postFinding(req: PostFindingRequest): Promise<PostFindingResponse>;
}

// container/watchdog/src/driverLoop.ts
interface DriverConfig {
  heartbeatSeconds: number;
  pollSeconds: number;
  idleShutdownSeconds: number;
  staleWindowSeconds: number;
  defaultChannel: string;        // message-board channel for findings/heartbeat output
  agentIdentity: string;         // sent as X-Agent-Name on every server request
  workspaceRepoPath: string;
}

interface DriverCursors {
  lastBoardMessageId: number;                // largest message_id from POST /messages observed
  lastCommitShaPerBranch: Record<string, string>;
  // key = agent branch name (e.g. 'docker/myproj/agent-1'); value = last commit SHA seen.
  lastBuildId: number;                       // largest build_history.id observed
}

interface NewCommit {
  branch: string;            // agent branch name
  sha: string;
  authorTime: string;        // ISO8601
  message: string;           // full commit message body, including subject
  filesChanged: number;
  insertions: number;
  deletions: number;
}
async function fetchNewCommits(
  workspaceRepoPath: string,
  cursors: DriverCursors,
  agentBranches: string[],
): Promise<NewCommit[]>;
// Implementation: `git -C <workspaceRepoPath> fetch /repo.git
//   '+refs/heads/docker/${PROJECT_ID}/*:refs/heads/docker/${PROJECT_ID}/*'`,
// then per branch `git log --pretty=...` for the cursor..head range.
// Returns commits in author-time order, oldest first.
// Mutates cursors.lastCommitShaPerBranch on completion.

async function runDriver(client: ServerClient, cfg: DriverConfig): Promise<void>;
// Loop:
//   1. Sleep pollSeconds.
//   2. Fetch coalesce status; if project has been idle for >= idleShutdownSeconds,
//      log shutdown reason and return (container exits with code 0).
//   3. Fetch window + state from server.
//   4. fetchNewCommits() to refresh and pull new commits since the per-branch
//      cursor. The commit messages join the audit evidence pool alongside
//      board messages.
//   5. Filter window + commits to evidence newer than cursors.
//   6. Decide nextTrigger via shouldAudit(filteredWindow, newCommits, state,
//      lastInspectionAt, heartbeatSeconds, staleWindowSeconds).
//   7. If trigger: run audit (Phase 6), record inspection, optionally post finding,
//      advance cursors past the evidence consumed.
//   8. Repeat.

// container/watchdog/src/triggers.ts
type Trigger =
  | { kind: 'none' }
  | { kind: 'heartbeat' }
  | { kind: 'matcher'; matcherKey: string; source: 'board' | 'commit'; ref: string }
  | { kind: 'anomaly'; anomalyKey: string; detail: string }
  | { kind: 'mention'; source: 'board'; messageId: number }
  | { kind: 'stale_window'; sinceSeconds: number };
// matcher.ref is `board#<id>` for board hits and `commit#<sha>` for commit hits.

function shouldAudit(args: {
  window: LmWindowResponse;
  newCommits: NewCommit[];
  state: LmStateResponse;
  lastInspectionAt: string | null;
  heartbeatSeconds: number;
  staleWindowSeconds: number;
}): Trigger;
// Priority within a single poll: mention > matcher > anomaly > stale_window > heartbeat.
// stale_window fires only when a heartbeat is due AND the window has zero new evidence
// (no new board messages, no new commits, no new builds, no new task transitions) since
// the last inspection. This is itself a finding (Phase 7), not a quiet heartbeat.
```

**Work:**

- Set up [`container/watchdog/package.json`](../container/watchdog/package.json) with the same ESM/Node ≥ 20 conventions used by the server (TypeScript, `tsx` for dev, `tsc` for build).
- The driver's "last inspection" cursor is recovered on startup from `GET /lm/state`. Container restarts are therefore stateless on the heartbeat clock — server is truth. Per-evidence cursors (`lastBoardMessageId`, `lastCommitShaPerBranch`, `lastBuildId`) start at zero/empty on each container run; the first poll after start fetches the full window and the LM's first audit sees everything since the last server-recorded inspection. Subsequent polls in the same run advance the cursors past evidence already consumed.
- Idle shutdown uses the existing `GET /coalesce/status` endpoint at [`server/src/routes/coalesce.ts`](../server/src/routes/coalesce.ts) line 27. The driver tracks `idleSinceTs`: when a poll returns `canCoalesce: true`, set `idleSinceTs` to now if unset; when it returns `false`, clear `idleSinceTs`. When `now − idleSinceTs >= idleShutdownSeconds`, post one `lm_shutdown` message-board entry and exit.
- All HTTP requests carry `X-Project-Id: ${PROJECT_ID}`. Server-side scoping (already enforced by [`server/src/plugins/project-id.ts`](../server/src/plugins/project-id.ts)) keeps the watchdog confined to its project.
- The driver is the only consumer of the Phase 2 endpoints. No other service writes to `lm_inspections`.

**Worked example — heartbeat clock arithmetic.** Heartbeat is *time since last inspection of any kind*, not *time since last heartbeat*. Concrete trace with `WATCHDOG_HEARTBEAT_SECONDS=1800` (30 min):

- T+0: container starts, `lastInspectionAt=null`, driver fires a heartbeat audit immediately, server records inspection finishing at T+0:02.
- T+0:25: a matcher tripwire fires, audit runs and records inspection finishing at T+0:27.
- T+0:50: driver polls. `now − lastInspectionAt = 23 min < 30 min`. **No heartbeat.** Correct.
- T+0:57: driver polls. `now − lastInspectionAt = 30 min`. Heartbeat fires.

Inverted arithmetic (heartbeat measured from previous heartbeat instead of from last inspection) would have re-fired at T+0:30 right after the matcher audit completed at T+0:27 — three minutes of redundant Opus work. The arithmetic gate is `now − lastInspectionAt ≥ heartbeatSeconds`, **not** `now − lastHeartbeatAt ≥ heartbeatSeconds`.

**Verification:**

- Unit tests for [`container/watchdog/src/driverLoop.test.ts`](../container/watchdog/src/driverLoop.test.ts) and [`container/watchdog/src/triggers.test.ts`](../container/watchdog/src/triggers.test.ts) using fake clocks. Coverage: heartbeat fires when and only when `now − lastInspectionAt ≥ heartbeatSeconds`; tripwire-fired audits reset the clock; multiple tripwires within a single poll cycle pick the highest-priority trigger (mention > matcher > anomaly > stale_window > heartbeat); a heartbeat-due poll with zero new evidence emits `stale_window` rather than `heartbeat`; cursors advance past consumed evidence so the next poll does not re-trigger; the driver exits cleanly when coalesce reports idle for `idleShutdownSeconds`.
- `npm test` green inside [`container/watchdog/`](../container/watchdog/).

<!-- PHASE-BOUNDARY -->

## Phase 5 — Triage rules: matchers, anomalies, mentions

**Outcome:** The driver decides whether new activity justifies an Opus audit. Three rule families run on every poll over the *cursor-filtered* slice of the evidence pool (board messages newer than `lastBoardMessageId`, commits newer than `lastCommitShaPerBranch`, builds newer than `lastBuildId`): regex/string matchers over board-message text and commit-message text, numeric anomaly checks over phase durations / diff sizes / build deltas, and direct-mention detection on board messages. A trigger is emitted when any rule fires; if no rule fires and the heartbeat is due, the driver picks `stale_window` (when no new evidence exists since the last inspection) or `heartbeat` (when there is new evidence that simply didn't trip a rule).

**Types / APIs:**

```ts
// container/watchdog/src/matchers.ts
interface MatcherConfig {
  // Loaded from /opt/watchdog/matchers.json at container start; hot-reload not required.
  phrases: Array<{
    key: string;          // stable identifier, e.g. 'scoped_to_previous_phase'
    pattern: string;      // case-insensitive regex
  }>;
}
function findMatcherHits(args: {
  boardMessages: LmWindowResponse['recentBoardMessages'];
  newCommits: NewCommit[];
  cfg: MatcherConfig;
}): Array<{
  matcherKey: string;
  source: 'board' | 'commit';
  ref: string;            // 'board#<id>' or 'commit#<sha>'
}>;
// Matcher hits and anomaly hits are triggers, not pre-judged findings.
// They cause an audit to run; the LM (Phase 7) assigns severity based on the
// full window context, including corroborating evidence.
// Commit messages are scanned in full (subject + body); engineer rationalisation
// language often appears in commit bodies more than in board messages.

// container/watchdog/src/anomalies.ts
interface AnomalyHit { anomalyKey: string; detail: string }
function findAnomalies(window: LmWindowResponse): AnomalyHit[];
// Initial rule set:
//   - phase_too_fast: a task transitioned to 'completed' in < 60s of wall-clock
//     time since 'in_progress'.
//   - test_failure_count_increased: most recent test build for an agent has more
//     tests_failed than its previous test build on the same agent. Fires only
//     when both prev.testsFailed and now.testsFailed are non-null (the project
//     has opted in to test-count parsing — see Phase 1). For projects that have
//     not opted in, this anomaly silently no-ops; matchers and the heartbeat
//     remain in force. When it does fire, the audit decides whether the increase
//     is legitimate (e.g. TDD red-phase, where the agent has just committed a
//     deliberately failing
//     test) or a regression the agent is rationalising as out-of-scope.
//   - diff_size_outlier: most recent commit on an agent branch touched > 50
//     files OR > 2000 added lines.
// Thresholds live alongside the matcher config in /opt/watchdog/anomalies.json.

// container/watchdog/src/mentions.ts
function findMentions(args: {
  boardMessages: LmWindowResponse['recentBoardMessages'];
  watchdogHandle: string;
}): Array<{ source: 'board'; messageId: number }>;
// watchdogHandle defaults to 'lm' / '@lm' / 'line manager' (case-insensitive).
// Mentions only scan board messages — engineers post their work and any direct
// requests for LM intervention to the message board.
```

**Work:**

- Seed [`container/watchdog/matchers.json`](../container/watchdog/matchers.json) with the operator-curated phrase list. Initial entries (each as a `key` + `pattern` regex):
  - `scoped_to_previous_phase` — `\bscoped to (a |the )?(previous|earlier) phase\b`
  - `pre_existing_failure` — `\bpre[- ]existing\b.*\b(failure|test|bug)\b`
  - `baseline_failures` — `\bbaseline (test )?failures?\b`
  - `out_of_scope_errors` — `\bout[- ]of[- ]scope (error|failure)s?\b`
  - `we_can_address_later` — `\b(we|i)('|'|)ll address (this|that|it) later\b`
  - `skipped_for_now` — `\bskip(ped|ping) (this|that|the test)? for now\b`
  - `already_broken` — `\bthis (was )?already broken\b`
- Anomaly thresholds and matcher list are configuration, not code — operators tune them without rebuilding the image. Both files are mounted into the container via the existing read-only bind for [`container/watchdog/`](../container/watchdog/).

**Worked example — `test_failure_count_increased` direction and corroboration.** The arithmetic gate is sign-sensitive; the *interpretation* of a hit is corroboration-sensitive. Concrete trace (project has opted in — both rows have non-null `tests_failed`):

- Agent `agent-1` built at T+0 with 3 test failures (`tests_failed=3`).
- Agent `agent-1` built at T+1 with 5 test failures (`tests_failed=5`).
- `5 > 3`, the count increased for the same agent — **fire the trigger**. The trigger says "an audit is warranted", not "this is a regression".
- Sign-sensitivity: the comparison is `now.testsFailed > prev.testsFailed` on the **same agent** (`build_history.agent`), **most recent two builds with non-null `tests_failed`**. Inverted form (`prev > now`) would fire only when the suite improves — silencing the signal entirely. Builds with NULL `tests_failed` (project not opted in, or test suite never ran due to auto-build failure) are excluded from the comparison; the rule needs two non-null values to fire.
- The audit window includes commits between T+0 and T+1 plus messages in the same window. The LM (Phase 7) decides the outcome from the bundle:
  - Commit message says "add failing tests for happy-path login (TDD red phase)" and the new failing tests are in the file the commit touched → **quiet**, this is normal red-phase work.
  - No agent commits in the window AND a container restart is visible in the activity log → ambiguous — earlier phase failures may have been left behind, or the restart itself caused them; the LM emits a `note` so the operator can confirm whether the failures belong to the agent's prior incarnation.
  - Commits touch unrelated files AND a message in the window contains rationalisation language matched by `pre_existing_failure` / `out_of_scope_errors` / `scoped_to_previous_phase` → **pause**, the agent is plausibly disclaiming failures their own work caused.

**Verification:**

- Unit tests in [`container/watchdog/src/matchers.test.ts`](../container/watchdog/src/matchers.test.ts), [`container/watchdog/src/anomalies.test.ts`](../container/watchdog/src/anomalies.test.ts), [`container/watchdog/src/mentions.test.ts`](../container/watchdog/src/mentions.test.ts).
- The matcher test asserts each seeded phrase fires on a positive sample placed in a board message and a positive sample placed in a commit message body (returning correct `source` and `ref`), and does not fire on a hand-crafted near-miss (e.g. `scoped_to_previous_phase` does not fire on "this is scoped to the current phase").
- The anomaly test asserts `test_failure_count_increased` fires for `(prev=3, now=5)`, does not fire for `(prev=5, now=3)` or `(prev=3, now=3)`, and does not fire when either side is NULL (`(prev=null, now=5)`, `(prev=3, now=null)`, `(prev=null, now=null)`).
- A `fetchNewCommits` test in [`container/watchdog/src/fetchCommits.test.ts`](../container/watchdog/src/fetchCommits.test.ts) using a tmp bare repo + agent branch: cursor empty on first call returns the full branch history; cursor at HEAD returns empty; cursor partway returns only commits after it; cursor advances correctly across multiple branches.

<!-- PHASE-BOUNDARY -->

## Phase 6 — Audit invocation: bundle, claude -p, emit finding

**Outcome:** When a trigger fires, the driver assembles a context bundle, invokes a fresh Opus session via `claude -p` with the watchdog agent definition (Phase 7), parses the response, and posts at most one finding to the configured message-board channel via `POST /lm/findings`. Quiet outcomes record the inspection but post nothing, except on heartbeat (a single-line "all quiet" entry is always posted on heartbeat to confirm the watchdog is alive). `stale_window` triggers must not return `quiet` — the agent definition forbids it (Phase 7).

**Types / APIs:**

```ts
// container/watchdog/src/audit.ts
interface AuditContext {
  trigger: Trigger;
  window: LmWindowResponse;
  workspace: { repoPath: string; branchHeads: Record<string, string> };
  // branchHeads[agentName] is the most recent commit SHA on
  // docker/{projectId}/{agentName} after the driver's most recent fetch.
  newCommits: NewCommit[];
  // Full commit list since the per-branch cursor — subject and body included.
  cumulativeDiffs: Array<{
    agentName: string; seedHeadSha: string; nowSha: string;
    filesChanged: number; insertions: number; deletions: number;
    truncatedDiffText: string; // first 4000 chars of `git diff <seedHeadSha>..<nowSha>`
  }>;
  // Diff is cumulative-since-seed (against docker/${PROJECT_ID}/current-root HEAD),
  // not incremental-since-last-poll. The LM judges scope by reading the full set of
  // files the agent has touched since branching from seed.
  recentBoardLmFindings: LmWindowResponse['recentBoardMessages'];
  // The subset of recentBoardMessages with type='lm_finding' — the LM's memory of
  // what it has already flagged in this run, so it can choose to escalate or stay
  // quiet rather than repeat itself verbatim.
}

interface AuditResult {
  outcome: 'quiet' | 'finding' | 'budget_exhausted' | 'error';
  finding?: {
    severity: 'note' | 'pause';
    title: string;
    body: string;
    notifyOperator: boolean;
  };
  inputTokens: number;
  outputTokens: number;
}

async function runAudit(ctx: AuditContext, opts: { agentType: string; budgetRemaining: number }): Promise<AuditResult>;
```

**Work:**

- Bundle assembly steps:
  1. The driver has already done `git fetch` and populated `newCommits` during the poll cycle that produced the trigger (Phase 4). Reuse that data — no extra fetch needed at audit time.
  2. For each agent in `window.agents`, populate `cumulativeDiffs[i]` by capturing `seedHeadSha` (HEAD of `docker/${PROJECT_ID}/current-root` after the driver's fetch), `nowSha` (HEAD of the agent's branch), and the truncated diff text from `git diff <seedHeadSha>..<nowSha>` capped at 4000 characters.
  3. Include the **full** `newCommits` list with their full commit messages (subject + body), and the **full** `recentBoardMessages` list capped at 50 — both surfaces are first-class evidence for the LM, not statistically sampled. (Engineer-side volume on these surfaces is bounded by phase cadence; sampling would discard the tail of the conversation that is most likely to contain the rationalisation language we care about.)
  4. Build the prompt using the watchdog agent definition (Phase 7) plus the JSON-serialised bundle.
- Invocation: spawn `claude -p` as a child process with stdin = prompt and `--output-format json` so token counts are recoverable. Honour `CLAUDE_CREDENTIALS_PATH` from the existing mount. The agent invoked is the per-project wiring named by `WATCHDOG_AGENT_TYPE` (Phase 7) — e.g. `lm-watchdog-ue` or `lm-watchdog-scaffold` — compiled from [`dynamic-agents/`](../dynamic-agents/) into the container's compiled agents directory by [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) at container start.
- The LM's terminal output is a JSON envelope (Schema axis, Phase 7). The LM has no HTTP, no message-board tools, no chat-room tools — it prints the envelope to stdout and exits. The driver parses the envelope into `AuditResult` and is the sole author of every downstream side-effect: `POST /lm/findings` for findings, `POST /messages` for heartbeat-quiet, `POST /coalesce/pause` for pause severity. The driver also constructs the `messages.payload` shape used on the board, translating from the LM's envelope rather than passing it through verbatim — the envelope is an LM↔driver contract, not a wire format.
- On heartbeat with `outcome='quiet'`: post a one-line entry to the message board on `WATCHDOG_DEFAULT_CHANNEL` via `POST /messages` with `type='lm_heartbeat'` and payload `{text: 'LM heartbeat — quiet, no findings'}`. On any other trigger with `outcome='quiet'`: record the inspection but post nothing. `stale_window` cannot produce `quiet` — if the LM's response says it did, treat as an `error` outcome.
- On `outcome='finding'`: call `POST /lm/findings`. The server inserts the message-board row and updates the inspection's `produced_message_id` in the same handler (Phase 2).
- On `outcome='budget_exhausted'`: post a one-line entry once per UTC day on `WATCHDOG_DEFAULT_CHANNEL` with `type='lm_budget_exhausted'`, then short-circuit subsequent audits to a no-op until the day rolls over.

**Verification:**

- Tests in [`container/watchdog/src/audit.test.ts`](../container/watchdog/src/audit.test.ts) using a fake `claude -p` (a stub binary on `PATH`) that returns canned JSON envelopes for `quiet`, `finding`, and `error` cases.
- Coverage: heartbeat-quiet posts one message-board entry on the default channel with `type='lm_heartbeat'`; non-heartbeat-quiet posts nothing; `outcome='finding'` posts one entry with `type='lm_finding'` and the inspection's `produced_message_id` updates to the new row's ID; budget exhaustion posts once per UTC day with `type='lm_budget_exhausted'`; malformed audit JSON yields `outcome='error'` and an inspection row with `outcome='error'`; a `stale_window` trigger returning `quiet` is treated as `error`.

<!-- PHASE-BOUNDARY -->

## Phase 7 — Watchdog agent definition split along PSDE axes

**Outcome:** The Line Manager's behaviour is decomposed into the project's standard four-axis split — Protocol and Schema as shared skills under [`skills/`](../skills/), Domain and Environment as per-project skills under [`skills/`](../skills/), and a thin per-project agent wiring under [`dynamic-agents/`](../dynamic-agents/) that composes them via the `skills:` frontmatter array. [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) compiles the agent named in `WATCHDOG_AGENT_TYPE` into the container's compiled agents directory, inlining all referenced skills.

**Types / APIs:**

The Schema axis owns the LM's **terminal output contract** — the JSON envelope the LM prints to stdout as its last action before `claude -p` exits. The driver (Phase 6) parses this envelope and is responsible for every downstream side-effect: posting to the message board, emailing the operator, calling `/coalesce/pause`. The LM itself has no HTTP access, no message-board tools, and no chat-room tools; it cannot post anywhere. This is a contract between the LM and the driver, not a wire format for the message board — the driver constructs each `messages.payload` from the parsed envelope using a shape suitable for the dashboard.

```json
{
  "outcome": "quiet" | "finding",
  "finding": {
    "severity": "note" | "pause",
    "title": "<short, specific>",
    "body": "<2-6 sentences; cites concrete agent names, branches, and evidence references in the form 'board#<id>' for message-board entries or 'commit#<sha>' for git commits so the operator can navigate to the originating evidence>",
    "notifyOperator": true | false
  } | null,
  "rationale": "<one paragraph; the LM's reasoning, kept for the inspection log>"
}
```

**Work — shared skills (one copy, used by every LM wiring):**

- [`skills/lm-audit-protocol/SKILL.md`](../skills/lm-audit-protocol/SKILL.md) — `axis: protocol`. The full audit protocol the LM follows on every invocation: read-only role boundary (no Edit, no Write, no push, no mutation, no HTTP, no message-board access, no chat-room access — the LM's terminal action is always to print a JSON envelope to stdout per the Schema axis, and the driver handles every downstream side-effect); the two evidence surfaces the LM reasons over are board messages (orchestrator debriefs, `phase_*` posts, `status_update` posts) and commit messages on agent branches in the bare repo — chat rooms are not part of the LM's evidence and must not be cited in findings; how to weight the bundle (recent test-failure deltas dominate; matcher hits are pre-flagged signals to second-guess rather than blindly trust; phase-too-fast anomalies require commit-content corroboration before promoting to a finding); severity decision tree for `pause` vs `note` (pause only for safety/correctness regressions that would compound across subsequent phases AND that the agent is plausibly responsible for — agent commits in the window touching the failing test's subject, deletion or `.skip` of test files, agent commits outside the task's declared scope, or rationalisation language attached to failures the agent's own commits could have caused; a test-failure increase without that corroboration is `note` at most; a TDD red-phase commit that adds deliberately-failing tests is `quiet`; after a container restart, treat phase-boundary attribution claims with extra scepticism); `stale_window` discipline (an active project with no new commits, builds, or messages for 30 minutes is itself a finding — the LM emits `severity='note'` minimum citing silent agents, and `severity='pause'` if any pump agent is in a non-idle status while producing no activity; **never** return `quiet` on a `stale_window` trigger); using `recentBoardLmFindings` as memory of what has already been flagged in this run (restate only when conditions have *worsened* warranting escalation; emit a `severity='note'` "previously flagged X has resolved" finding when conditions improve; return `quiet` when conditions are unchanged); when to set `notifyOperator=true` (every `severity='pause'` finding sets it; `severity='note'` findings set it when the LM judges the operator should look without delay).
- [`skills/lm-finding-schema/SKILL.md`](../skills/lm-finding-schema/SKILL.md) — `axis: schema`. Defines the LM's **terminal output contract** — the single JSON object the LM prints to stdout as its last action. The skill states explicitly that this envelope is consumed by the driver process, not by any human or message-board reader; the LM does not post messages itself. The body locks the envelope shape (verbatim restatement at the end of the skill so the driver's "last fenced JSON block in the response" parser hits a known shape) and lists per-field validation rules: `outcome` MUST be a string literal from the closed set; `finding` MUST be `null` when `outcome='quiet'` and an object when `outcome='finding'`; `severity` MUST be exactly `'note'` or `'pause'` (the driver rejects any other value as malformed); `title` MUST be ≤ 120 characters; `body` MUST cite at least one concrete reference in `board#<id>` or `commit#<sha>` form; `notifyOperator` MUST be a boolean.

**Work — per-project skills (one set per project the LM watches):**

Each project the scaffold supports — including the scaffold itself — gets its own pair of LM-flavoured Domain and Environment skills. The split mirrors the existing convention (`scaffold-server-patterns` ↔ `ue-cpp-style` for domain; `scaffold-environment` ↔ `ue-engine-mount` for environment), but written from the read-only auditor's perspective rather than the implementer's.

For the UE flavour (PistePerfect and any other UE project):

- [`skills/lm-domain-ue/SKILL.md`](../skills/lm-domain-ue/SKILL.md) — `axis: domain`. What slop looks like in UE C++ work: the rationalisation language UE engineers reach for when failures cross phase boundaries (e.g. "PIE crash on shutdown is unrelated", "asset cook failure was already there", "shader compilation regression is engine-side"); UE-specific test category names that recur in `recentBuilds` output (automation tests, Slate UI tests, gameplay tests); diff red flags specific to UE (touching files under `Engine/`, edits to `*.uasset` / `*.umap` outside an asset-migration task, broad changes under `Source/<Project>/Public/` from a phase scoped to one module, `.ini` config edits without a stated reason); commit-message patterns that signal scope drift in UE work.
- [`skills/lm-environment-ue/SKILL.md`](../skills/lm-environment-ue/SKILL.md) — `axis: environment`. The watchdog's read-only view of a UE project: bare repo mount at `/repo.git` (read-only), the LM's own clone at `/workspace/repo` (writable for fetch/worktree only, never pushed back), branch convention `docker/${PROJECT_ID}/{current-root,<agent-name>}`, how to recognise UE build vs UE test rows in `recentBuilds` (build script names from `BUILD_SCRIPT_NAME` / `TEST_SCRIPT_NAME` env, exit-code conventions), where engine source can be consulted if a claim about engine behaviour needs a sanity check (the existing [`skills/ue-engine-mount/SKILL.md`](../skills/ue-engine-mount/SKILL.md) describes the path and is composed in by the LM-UE wiring as a secondary skill if the LM is granted access to `/engine`), and the LM's tool budget (`Read`, `Grep`, `Bash` for `git log` / `git diff`).

For the scaffold flavour (the scaffold's own self-hosted LM watching scaffold development work):

- [`skills/lm-domain-scaffold/SKILL.md`](../skills/lm-domain-scaffold/SKILL.md) — `axis: domain`. What slop looks like in scaffold work: TypeScript-flavoured rationalisation phrasing (e.g. "type assertion is fine here", "the test was flaky already", "ESM resolution issue is unrelated"); recurring scaffold-specific risk patterns (drift between [`dynamic-agents/`](../dynamic-agents/) and `agents/` when compile is bypassed; SQL injection or shell injection slipping past the existing safety reviewers; PGlite test-helper isolation getting violated); diff red flags specific to scaffold (broad changes under [`server/src/schema/`](../server/src/schema/) from a phase that didn't declare a migration, route files modified without corresponding test files, [`container/hooks/`](../container/hooks/) edits without intercept-hook test coverage); commit-message patterns that signal scope drift in scaffold work.
- [`skills/lm-environment-scaffold/SKILL.md`](../skills/lm-environment-scaffold/SKILL.md) — `axis: environment`. The watchdog's read-only view of the scaffold project: same `/repo.git` + `/workspace/repo` shape; how to recognise scaffold build/test rows in `recentBuilds` (`npm run build` and `npm test` per workspace package, scaffold-specific exit conventions); pointer to the existing [`skills/scaffold-environment/SKILL.md`](../skills/scaffold-environment/SKILL.md) for codebase layout (composed in by the LM-scaffold wiring as a secondary skill); the LM's tool budget identical to the UE flavour.

**Work — per-project agent wirings:**

- [`dynamic-agents/lm-watchdog-ue.md`](../dynamic-agents/lm-watchdog-ue.md) — front matter: `name: lm-watchdog-ue`, `model: opus`, `tools: [Read, Glob, Grep, Bash]`, `disallowedTools: [Edit, Write]`, `skills: [lm-audit-protocol, lm-finding-schema, lm-domain-ue, lm-environment-ue, ue-engine-mount]`. Body is one paragraph framing the agent as a read-only Line Manager auditing UE project work; the skills compose to the full behaviour.
- [`dynamic-agents/lm-watchdog-scaffold.md`](../dynamic-agents/lm-watchdog-scaffold.md) — front matter: `name: lm-watchdog-scaffold`, `model: opus`, `tools: [Read, Glob, Grep, Bash]`, `disallowedTools: [Edit, Write]`, `skills: [lm-audit-protocol, lm-finding-schema, lm-domain-scaffold, lm-environment-scaffold, scaffold-environment]`. Body matches the UE wiring with scaffold-flavour framing.

**Operator selection of the wiring:** the existing `WATCHDOG_AGENT_TYPE` env var (Phase 3) names which agent definition the watchdog compiles. UE projects set `WATCHDOG_AGENT_TYPE=lm-watchdog-ue`; the scaffold sets `WATCHDOG_AGENT_TYPE=lm-watchdog-scaffold`. A new project adding LM coverage authors a new pair of `lm-domain-{project}` + `lm-environment-{project}` skills and a new `dynamic-agents/lm-watchdog-{project}.md` wiring — the shared `lm-audit-protocol` and `lm-finding-schema` skills are written once and never duplicated.

**Verification:**

- After Phase 7's files land, both `lm-watchdog-ue.md` and `lm-watchdog-scaffold.md` are picked up by [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) — the compiler runs without warnings and the resulting compiled agent files contain inlined content from each declared skill in the order declared. (Per the existing memory, do not run the compile script by hand — exercise it via the existing automated path that triggers when the watchdog container starts.)
- Compiled output for both wirings includes the full Protocol and Schema bodies verbatim and the wiring's specific Domain + Environment bodies.
- A hand-run audit driven by Phase 10's smoke test, against the `WATCHDOG_AGENT_TYPE` set for the project under test, returns a valid JSON envelope; the driver's parser accepts it without error.

<!-- PHASE-BOUNDARY -->

## Phase 8 — Token budget cap and pause-tier wiring

**Outcome:** The watchdog respects a per-project daily Opus token budget and downgrades to a no-op once exhausted, resetting at UTC midnight. Findings with `severity='pause'` additionally call `POST /coalesce/pause` for the project after the message lands.

**Types / APIs:**

Project-level configuration extension in [`server/src/schema/tables.ts`](../server/src/schema/tables.ts) `projects`:

```ts
// Additive column on the existing 'projects' table.
watchdogDailyTokenBudget: integer('watchdog_daily_token_budget').notNull().default(0),
// 0 means unlimited. Operators set this via the existing PATCH /projects/{id} route.
```

`GET /lm/state` (Phase 2) reads from this column. The driver checks `state.budgetExhausted` before invoking `claude -p`; if true, it records `outcome='budget_exhausted'` immediately without spending tokens.

**Work:**

- Migration adds the `watchdog_daily_token_budget` column with default `0`.
- [`server/src/routes/projects.ts`](../server/src/routes/projects.ts) `PATCH /projects/{id}` accepts the new field.
- The driver's audit step (Phase 6) reads `LmStateResponse.budgetExhausted` before each invocation. On exhaustion, the driver records the inspection with `outcome='budget_exhausted'` and skips the `claude -p` call.
- Tier-2 escalation: after `POST /lm/findings` succeeds with `severity='pause'`, the driver immediately calls `POST /coalesce/pause` (existing endpoint at [`server/src/routes/coalesce.ts`](../server/src/routes/coalesce.ts) line 71). Over-pausing is prevented behaviourally: the LM consults `recentBoardLmFindings` and re-emits `severity='pause'` only when conditions have worsened relative to a prior pause finding (Phase 7 guidance). The cursor model also guarantees the underlying *evidence* fires its trigger only once.

**Worked example — pause is behavioural, not enforced.** Concrete trace showing why dedup is not needed at this layer:

- Audit returns `severity='pause'` for "test_failure_count_increased on agent-1, count went 3 → 5". `POST /coalesce/pause` is called once. Pump pauses.
- Operator investigates, resumes pumps, agent-1 lands a fix, next test build shows 5 → 2 failures. The cursor `lastBuildId` is past both builds — the anomaly trigger does not re-fire.
- Hypothetical: operator does nothing, agent commits more without addressing the failing tests, next test build shows 5 → 6. New build_id past the cursor, anomaly trigger fires, audit runs, sees `recentBoardLmFindings` containing the prior pause finding, decides "conditions have worsened (5 → 6 vs the previously-flagged 3 → 5)" and emits a fresh `severity='pause'` finding. A second pause call lands. This is correct — the situation is genuinely worse and another nudge to the operator is warranted.
- Hypothetical: operator does nothing, no further commits, no further builds. Cursor is past the last build, no anomaly, no new evidence. The LM either returns `quiet` (matching the prior finding state) or (after 30 min of total silence) `stale_window` flags the lack of progress. Either way, no second `severity='pause'` is emitted on unchanged conditions.

**Verification:**

- Tests in [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts): budget-exhausted state computed correctly; budget reset behaviour at UTC midnight (use a fake clock).
- Tests in [`container/watchdog/src/audit.test.ts`](../container/watchdog/src/audit.test.ts): `severity='pause'` triggers the `POST /coalesce/pause` call once per finding; `severity='note'` does not call pause; `outcome='budget_exhausted'` does not invoke `claude -p`.

<!-- PHASE-BOUNDARY -->

## Phase 9 — Out-of-band operator notification via Resend

**Outcome:** When a finding lands with `notifyOperator: true`, the server sends a plain-text email to the project's configured operator address via the Resend HTTP API. Cooldown and a daily cap prevent flooding. The watchdog container never holds the Resend API key — it only sets a flag on the finding. If notification is requested but cannot be sent (no address configured, no API key, cooldown, daily cap reached), the response carries the reason and the inspection still records as `outcome='finding'` with the message-board entry intact.

**Types / APIs:**

Schema additions in [`server/src/schema/tables.ts`](../server/src/schema/tables.ts):

```ts
// Additive column on the existing 'projects' table.
operatorEmail: text('operator_email'),
// Null disables operator email for the project even when notifyOperator=true.

// New table.
// Each row references EXACTLY ONE outbound message via the two FK columns
// (board OR chat, never both, never neither) — same exclusivity pattern as
// lm_inspections.produced_message_id / produced_chat_message_id.
// onDelete is the Drizzle default ('restrict') on both FKs — deleting the
// referenced message must NOT cascade-delete the email audit row.
export const lmEmailLog = pgTable('lm_email_log', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  boardMessageId: integer('board_message_id').references(() => messages.id),
  chatMessageId: integer('chat_message_id').references(() => chatMessages.id),
  sentAt: timestamp('sent_at').notNull().defaultNow(),
  resendId: text('resend_id'),         // ID returned by Resend; null on failure or skip
  ok: boolean('ok').notNull(),         // true = email accepted by Resend; false = error or skipped
  reason: text('reason').notNull(),    // 'sent' | 'cooldown' | 'no_address' | 'no_api_key' | 'error'
  errorBody: text('error_body'),
}, (table) => [
  check(
    'lm_email_log_target_exclusive',
    sql`(${table.boardMessageId} IS NULL) <> (${table.chatMessageId} IS NULL)`,
  ),
]);
```

Server-host environment (never reaches the container):

```
RESEND_API_KEY=<resend api key>
RESEND_FROM=lm@<your-domain>
RESEND_COOLDOWN_MINUTES=15          # default 15 — minimum gap between successful emails per project
RESEND_DAILY_CAP=10                 # default 10 emails per project per UTC day
```

Internal module [`server/src/integrations/resend.ts`](../server/src/integrations/resend.ts):

```ts
interface SendEmailResult {
  ok: boolean;
  resendId: string | null;
  errorBody: string | null;
}
async function sendOperatorEmail(args: {
  to: string;
  from: string;
  subject: string;
  body: string;          // plain text
  apiKey: string;
}): Promise<SendEmailResult>;
```

**Work:**

- One Drizzle migration adds `projects.operator_email` and the `lm_email_log` table. [`server/src/routes/projects.ts`](../server/src/routes/projects.ts) `PATCH /projects/{id}` accepts `operatorEmail`.
- Inside [`server/src/routes/lm.ts`](../server/src/routes/lm.ts), `POST /lm/findings` performs the email side-effect *after* the message-board row inserts and *only if* `notifyOperator: true`.
- Email gating is checked in this fixed order; first failing check wins:
  1. `RESEND_API_KEY` unset on the host → `reason='no_api_key'`.
  2. `projects.operator_email` null → `reason='no_address'`.
  3. Most recent successful `lm_email_log` row for `projectId` (any message) is more recent than `now − RESEND_COOLDOWN_MINUTES` → `reason='cooldown'`. Cooldown is project-level, not finding-level: the goal is to keep the operator's inbox tolerable when a cascading failure produces a burst of distinct findings; the operator only needs one nudge per burst.
  4. Count of `lm_email_log` rows for `projectId` since today's UTC midnight where `ok=true` and `reason='sent'` is at least `RESEND_DAILY_CAP` → `reason='cooldown'` (cap-driven cooldown, same outcome shape).
  5. Otherwise call `sendOperatorEmail`. On HTTP success → `reason='sent'`, `ok=true`. On HTTP error → `reason='error'`, `ok=false`, `errorBody` set. Either way insert one `lm_email_log` row with `board_message_id` set to the just-posted `messages.id` (note/pause findings) — see Phase 10 for the chat-message variant.
- Subject line: `[LM ${projectId}] ${title}`. Body is plain text containing: project ID, finding title, finding body, severity, inspection ID, message-board channel, message-board entry ID, and a link to the message-board entry in the dashboard (if a dashboard URL is configured in project config — otherwise omit the link).
- The Resend wrapper performs no retries. A failed send lands in `lm_email_log` with `ok=false`; the operator inspects the log to triage. The route returns `emailed=false, emailReason='error'` to the watchdog so the inspection record correctly captures the attempt.
- Every email decision (skip or send, success or failure) lands in `lm_email_log` so the operator has a complete audit trail of what the LM tried to send and why.

**Worked example — cooldown direction.** The cooldown gate is sign-sensitive: cooldown is "time *since* last successful send", not "time *until* next allowed send". Concrete trace with `RESEND_COOLDOWN_MINUTES=15`:

- T+0:00: finding F1, `notifyOperator=true`. No prior `lm_email_log` for the project. `now − lastSentAt` is undefined → treated as ≥ 15 min. Send. New row `(boardMessageId=M1, chatMessageId=null, sentAt=T+0:00, ok=true, reason='sent')`.
- T+0:05: distinct finding F2 (different agent, different evidence), `notifyOperator=true`. `now − lastSentAt = 5min < 15min ⇒ skip`. New row `(messageId=M2, ok=false, reason='cooldown')`. The operator already got the F1 email; the F2 message is on the board for them to read when they look.
- T+0:16: distinct finding F3, `notifyOperator=true`. `now − lastSentAt(F1) = 16min ≥ 15min ⇒ send`. New row `(messageId=M3, ok=true, reason='sent')`.

The arithmetic gate is `now − lastSentAt ≥ cooldownWindow ⇒ allow send`. The inverted form (`now − lastSentAt > cooldownWindow ⇒ skip`) would only ever send the *first* email and silently swallow every subsequent one — the opposite of the goal.

**Verification:**

- New tests in [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts) using a fake Resend wrapper and fake clock. Coverage:
  - `notifyOperator=true` + `operatorEmail` set + key set + first time → email sent, `lm_email_log` row with `reason='sent', ok=true`, response `emailed=true, emailReason='sent'`.
  - `notifyOperator=true` + `operatorEmail=null` → response `emailed=false, emailReason='no_address'`, log row `reason='no_address', ok=false`.
  - `notifyOperator=true` + `RESEND_API_KEY` unset → response `emailed=false, emailReason='no_api_key'`, log row `reason='no_api_key', ok=false`.
  - Two findings 5 minutes apart with `RESEND_COOLDOWN_MINUTES=15` → first sends, second returns `emailReason='cooldown'`.
  - 11th send within the same UTC day → response `emailReason='cooldown'`.
  - Resend HTTP failure → response `emailReason='error'`, log row carries `errorBody`.
  - `notifyOperator=false` → response `emailed=false, emailReason='not_requested'`, no log row created.
- New tests in [`server/src/integrations/resend.test.ts`](../server/src/integrations/resend.test.ts) for the wrapper: success path returns `{ok: true, resendId}`, error path returns `{ok: false, errorBody}`.

<!-- PHASE-BOUNDARY -->

## Phase 10 — Intervention endpoint (server)

**Outcome:** A single new server endpoint, `POST /lm/interventions`, lets the watchdog driver post an `intervene`-tier finding into the target agent's existing chat room. No new room types, no new tables, no new join flow — engineer containers already join their assigned `CHAT_ROOM` via [`container/lib/registration.sh`](../container/lib/registration.sh) and the audit trail is fully reconstructible from `lm_inspections.produced_chat_message_id` + `chat_messages`.

**Types / APIs:**

New endpoint in [`server/src/routes/lm.ts`](../server/src/routes/lm.ts):

```ts
// POST /lm/interventions — driver-side
interface PostInterventionRequest {
  inspectionId: number;
  targetAgentName: string;
  body: string;             // the intervention message (≤ 4096 chars)
  notifyOperator: boolean;  // server emails operator if true (Phase 9 path, same gating)
}
interface PostInterventionResponse {
  chatMessageId: number;
  roomId: string;           // the target agent's chat room as resolved by the server
  emailed: boolean;
  emailReason?: 'sent' | 'cooldown' | 'no_address' | 'no_api_key' | 'error' | 'not_requested';
}
```

**Work:**

- `POST /lm/interventions` flow:
  1. Resolve `targetAgentName` to an agent UUID for the request's project (404 if unknown or soft-deleted).
  2. Resolve the agent's chat room: query `room_members` for rooms the agent is currently in. If exactly one room, use it. If multiple, prefer the room whose ID matches `engineers-${projectId}` if present, otherwise the most-recently-created room. If zero, return 409 `no_chat_room` — the driver records `outcome='error'` for the inspection and the operator gets notified via the standard email path so they can fix the launch wiring.
  3. Insert a row in `chat_messages` with `roomId = <resolved>`, `authorType = 'system'`, `authorAgentId = null`, `content = body`. (The `system` author type bypasses membership — see the precedent at [`server/src/routes/rooms.ts`](../server/src/routes/rooms.ts) line 304 for `operator`-typed posts; `system` follows the same pattern.)
  4. Update the corresponding `lm_inspections` row's `produced_chat_message_id` to the new `chat_messages.id`.
  5. If `notifyOperator: true`, run the same Phase 9 email gating, writing an `lm_email_log` row with `chat_message_id` set to the new chat message and `board_message_id` left NULL. The Phase 9 schema's `(boardMessageId XOR chatMessageId)` CHECK constraint enforces that exactly one column is populated per row; this is the chat-message branch.
  6. Return the chat message ID, the resolved room ID, and the email status.
- Register the new endpoint in [`server/src/routes/index.ts`](../server/src/routes/index.ts).
- Update [`server/src/schema/tables.ts`](../server/src/schema/tables.ts) `chat_messages.authorType` documentation to confirm `'system'` is a recognised value. The migration that added `produced_chat_message_id` lives in Phase 1; no schema change is required in this phase.

**Verification:**

- New tests in [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts):
  - `POST /lm/interventions` for an agent that is a member of one room posts the chat message with `authorType='system'`, sets `lm_inspections.produced_chat_message_id`, returns the IDs.
  - For an agent that is a member of multiple rooms with one matching `engineers-${projectId}`, the post lands in that preferred room.
  - For an agent that is a member of zero rooms, the route returns 409 `no_chat_room`.
  - For an unknown / soft-deleted agent, the route returns 404.
  - With `notifyOperator: true`, the email gating runs and writes an `lm_email_log` row referencing the chat message ID.

<!-- PHASE-BOUNDARY -->

## Phase 11 — Orchestrator chat-aware behaviour (engineer-side)

**Outcome:** Every engineer orchestrator agent that may be the target of an LM intervention can read messages from its assigned `CHAT_ROOM` and act on them between sub-agent delegations. The orchestrator's container already joins its `CHAT_ROOM` via [`container/lib/registration.sh`](../container/lib/registration.sh) — no new join flow is needed. What changes is the agent definition (chat tools added) and a new protocol skill that defines when and how to poll.

**Types / APIs:**

New shared protocol skill [`skills/orchestrator-intervention-protocol/SKILL.md`](../skills/orchestrator-intervention-protocol/SKILL.md) — `axis: protocol`. The skill body covers:

- The orchestrator's `CHAT_ROOM` is set by the launcher and joined automatically during container registration; the orchestrator does not need to do anything to join. If `CHAT_ROOM` is unset (legacy launches), the skill instructs the orchestrator to log a warning and proceed without intervention support.
- Poll points: at the end of every step in [`skills/orchestrator-phase-protocol/SKILL.md`](../skills/orchestrator-phase-protocol/SKILL.md) where control returns to the orchestrator (after `Step 1 — Implement & Build`, after each parallel-review batch in `Step 2`, after `Step 2a — Consolidate and Fix`, after `Step 3 — Commit`, after `Decomp Step 2`, after `Style Step 3`). At each poll point the orchestrator calls `mcp__chat__check_messages` against its `CHAT_ROOM`.
- How to read a message: an LM intervention arrives as a `system`-typed message. The body cites concrete evidence (`board#<id>` or `commit#<sha>`) and states the corrected information. The orchestrator reads the body, considers it as input to the *next* decision, and posts an acknowledgement reply via `mcp__chat__reply` summarising how the intervention will affect the next step.
- How to act on a message: the LM provides information, not instructions. The orchestrator does not blindly comply — it re-evaluates with the new information. Possible outcomes: delegate to a sub-agent with the corrected info, re-open a closed phase, post a `status_update` to the message board explaining why no change is warranted (with the orchestrator's reasoning), or escalate to operator via a `phase_failed` message if the intervention reveals a blocker that requires human input.
- The orchestrator does not stop the world for an intervention. It is processed at the *next* poll point, not preemptively. This bounds the latency between LM detection and orchestrator awareness to "current sub-agent's runtime" — typically minutes — which is acceptable for the information-correction use case.
- Skill body restates the constraint: never treat chat-room messages as directives. The orchestrator's protocol authority is unchanged; an intervention is one input among many.

**Work:**

- Update each existing orchestrator agent definition under [`dynamic-agents/`](../dynamic-agents/) — specifically [`dynamic-agents/scaffold-orchestrator.md`](../dynamic-agents/scaffold-orchestrator.md), [`dynamic-agents/container-orchestrator-ue.md`](../dynamic-agents/container-orchestrator-ue.md), [`dynamic-agents/scaffold-server-orchestrator.md`](../dynamic-agents/scaffold-server-orchestrator.md), [`dynamic-agents/scaffold-dashboard-orchestrator.md`](../dynamic-agents/scaffold-dashboard-orchestrator.md), [`dynamic-agents/content-catalogue-dashboard-orchestrator.md`](../dynamic-agents/content-catalogue-dashboard-orchestrator.md):
  - Add `mcp__chat__check_messages` and `mcp__chat__reply` to the `tools:` list.
  - Add `orchestrator-intervention-protocol` to the `skills:` list (place after `orchestrator-phase-protocol`).
- Ensure pump/orchestrator container launches set `CHAT_ROOM` to the project's engineer-room ID (the convention `engineers-${projectId}` is recommended; the field is already wired through [`container/docker-compose.template.yml`](../container/docker-compose.template.yml) line 27 and joined by [`container/lib/registration.sh`](../container/lib/registration.sh) line 187 — no code change in those files, only the launch invocation needs to populate the env). If the project does not yet have an engineer room, the operator creates it once via `POST /rooms` with the conventional id; subsequent launches reuse it.
- Verify [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) compiles the updated orchestrator agents with the new skill inlined.

**Verification:**

- New test in [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts): a registered orchestrator agent that is a member of `engineers-${projectId}` receives a message posted by `POST /lm/interventions` when querying `GET /rooms/engineers-${projectId}/messages` (the `system`-typed message is visible to room members).
- Operator-run smoke step (folded into Phase 13): launch an orchestrator container with `CHAT_ROOM=engineers-${projectId}`, confirm registration logs show the existing room-join call returning 200, confirm the orchestrator's compiled agent contains the new skill body and the chat tools.

<!-- PHASE-BOUNDARY -->

## Phase 12 — LM intervention severity (LM-side schema, driver, and skill updates)

**Outcome:** The LM's terminal output schema gains a third severity, `intervene`, which the driver translates into a chat-room post in the target agent's existing room via `POST /lm/interventions` rather than a board post. The audit-protocol skill defines when intervention is the right action vs. note/pause, and the LM's domain skills receive a short addition with project-specific intervention examples.

**Types / APIs:**

Schema axis update — the JSON envelope from Phase 7 becomes:

```json
{
  "outcome": "quiet" | "finding",
  "finding": {
    "severity": "note" | "pause" | "intervene",
    "title": "<short, specific>",
    "body": "<2-6 sentences; cites concrete agent names, branches, and evidence references in the form 'board#<id>' for message-board entries or 'commit#<sha>' for git commits>",
    "targetAgent": "<agent name, REQUIRED when severity='intervene', null otherwise>",
    "notifyOperator": true | false
  } | null,
  "rationale": "<one paragraph; the LM's reasoning, kept for the inspection log>"
}
```

Driver dispatch table:

| `severity`   | Driver action                                             | Side-effects                                       |
|--------------|-----------------------------------------------------------|----------------------------------------------------|
| `note`       | `POST /lm/findings`                                       | Board post; optional email                         |
| `pause`      | `POST /lm/findings` then `POST /coalesce/pause`           | Board post + pumps pause; optional email           |
| `intervene`  | `POST /lm/interventions`                                  | Chat-room post in `targetAgent`'s `CHAT_ROOM` (resolved server-side); optional email |

`intervene` does **not** call `/coalesce/pause`. Pause-class issues are unrecoverable through dialogue and warrant `severity='pause'`; intervention-class issues are recoverable through information and warrant `severity='intervene'`. The two are mutually exclusive within a single envelope; if the LM judges both halt and dialogue are needed, it emits `pause` first and `intervene` on the next inspection cycle once the operator has acknowledged the pause.

**Work:**

- Update [`skills/lm-finding-schema/SKILL.md`](../skills/lm-finding-schema/SKILL.md): add `intervene` to the severity enum; document `targetAgent` field semantics (REQUIRED when `severity='intervene'`, MUST be `null` when `severity` is `note` or `pause`); driver rejects envelopes that violate either constraint as malformed.
- Update [`skills/lm-audit-protocol/SKILL.md`](../skills/lm-audit-protocol/SKILL.md) with intervention guidance: when to choose `intervene` (a single agent — typically an orchestrator — has just made a decision based on a missing or incorrect piece of information, and providing the corrected information is likely to course-correct without halting); how to phrase an intervention body (state the corrected information directly, cite the specific commit or message that revealed the misinference, do **not** instruct the orchestrator on what to do — the orchestrator decides; the LM's role is to supply information, not directives); how to choose `targetAgent` (the agent whose recent decision the LM is correcting; if multiple agents share the misinference, prefer the orchestrator over implementers since orchestrators are persistent and implementers are short-lived); when `intervene` is wrong (correctness/safety regressions that compound across phases, where the right action is `pause`, not dialogue; observations the operator should know but no specific agent needs to act on, where the right action is `note`).
- Update each [`skills/lm-domain-{ue,scaffold}/SKILL.md`](../skills/) with two or three project-specific intervention examples (e.g. for UE: "the orchestrator just delegated a fix that targets the wrong UClass derivative because their plan reading missed an inheritance chain; intervene with the correct chain"; for scaffold: "the orchestrator is treating an `idle` agent as `done` due to misreading `/agents` output; intervene with the correct status semantics").
- Driver code in [`container/watchdog/src/audit.ts`](../container/watchdog/src/audit.ts) gains a dispatch branch on `severity='intervene'` that calls `POST /lm/interventions` with the parsed `targetAgent`, body, and `notifyOperator` flag. Update `AuditResult` to include the intervention post result alongside the existing finding result.
- The driver validates `targetAgent` non-null when `severity='intervene'` before calling the server. A null or empty `targetAgent` on an `intervene` envelope is treated as `outcome='error'` (malformed) and recorded as such on `lm_inspections`.

**Worked example — `intervene` vs `pause` direction.** This is sign-sensitive: choosing the wrong tier in the wrong direction silently degrades the watchdog's value.

- Orchestrator's last `phase_complete` board message says "Phase 3 done; safety-reviewer flagged a UPROPERTY on a UObject pointer without `UPROPERTY()` macro but I judged it out of scope for this phase." The LM reads the linked review output and finds the UPROPERTY *was* in this phase's diff. Information correction: orchestrator misread review scope. **Intervene**: post in the room "@orchestrator the missing UPROPERTY at `commit#<sha>` is in this phase's diff per the review's file list — please re-run the safety reviewer to confirm before advancing." The orchestrator factors this in on the next poll.
- Same orchestrator, different scenario: test_failure_count_increased fires (3 → 7), the agent's last commits touched the failing tests' subject files, the agent's `phase_complete` says "tests scoped to a previous phase, advancing." This is `pause` — the regression is plausibly the agent's responsibility, the orchestrator's judgment is wrong, and continuing across the phase boundary cements the slop into the next phase. Halting is the correct action; intervention would let the orchestrator continue while the LM "explains".
- Inverted pick (intervening when pause is correct, or pausing when intervene is correct) wastes the LM's authority. Pausing for an information-shaped issue irritates the operator and stalls work that could continue. Intervening for a safety-shaped issue lets the regression compound. The audit-protocol skill states this distinction in the LM's reading.

**Verification:**

- Update [`container/watchdog/src/audit.test.ts`](../container/watchdog/src/audit.test.ts) with stub envelopes for each severity; assert the driver calls `POST /lm/findings` for `note`, `POST /lm/findings` + `POST /coalesce/pause` for `pause`, and `POST /lm/interventions` for `intervene`. Assert `targetAgent: null` on `intervene` is rejected as malformed.
- A hand-run audit driven by Phase 13's smoke test, with conditions designed to elicit each severity, returns the expected envelope shape and the driver dispatches correctly.

<!-- PHASE-BOUNDARY -->

## Phase 13 — End-to-end smoke test

**Outcome:** The operator can launch a watchdog against a real project, observe one heartbeat audit producing an "all quiet" message, plant a matcher phrase in a board message and a separate matcher phrase in a commit message and observe two tripwire-driven audits each producing a finding referencing the correct surface, observe an `intervene`-tier finding posted into the orchestrator's `CHAT_ROOM` and acknowledged by the orchestrator, observe an email landing for a `notifyOperator=true` finding, and observe the watchdog self-shutting-down after the project goes idle. Confirm every inspection is recorded in `lm_inspections` (with `produced_chat_message_id` set for the intervention).

**Types / APIs:** None — this phase is the operator-run verification of the integrated system.

**Work:**

Document the smoke test in [`container/watchdog/SMOKE.md`](../container/watchdog/SMOKE.md):

1. **Preconditions.** Coordination server running on `${SERVER_PORT}`. A pump container has been launched at least once for the chosen project so `docker/${PROJECT_ID}/current-root` exists, an orchestrator container is running (so the intervention path has a target), and at least one task is pending or in-flight (so `/coalesce/status` returns `canCoalesce: false` while the test runs). `WATCHDOG_AGENT_TYPE` is set to the matching per-project wiring (e.g. `lm-watchdog-ue` for a UE project, `lm-watchdog-scaffold` for the scaffold). `WATCHDOG_HEARTBEAT_SECONDS=120`, `WATCHDOG_IDLE_SHUTDOWN_SECONDS=120`, `WATCHDOG_STALE_WINDOW_SECONDS=120` (all lowered for the test) in the operator's `.env`.
2. **Boot watchdog.** `./launch.sh --watchdog --project <id>`. Verify with `docker ps` that the `lm-watchdog` service is up. Tail container logs.
3. **First heartbeat.** Within `WATCHDOG_HEARTBEAT_SECONDS + WATCHDOG_POLL_SECONDS` of boot, query `GET /messages/${WATCHDOG_DEFAULT_CHANNEL}` and observe a single entry with `type='lm_heartbeat'`, `fromAgent` matching `WATCHDOG_AGENT_IDENTITY`, and payload text "LM heartbeat — quiet, no findings". Confirm one row in `lm_inspections` with `triggerKind='heartbeat'`, `outcome='quiet'`, and `produced_message_id` matching the entry's ID.
4. **Plant a board-message tripwire.** Operator posts a message to the project's message board with `POST /messages` (channel `general` or any agent-used channel — *not* `${WATCHDOG_DEFAULT_CHANNEL}`) reading "Test failures here are pre-existing — already broken before this phase." This contains both `pre_existing_failure` and `already_broken` matcher phrases. The watchdog scans the board on its next poll and the matcher fires.
5. **Tripwire audit.** Within `WATCHDOG_POLL_SECONDS` of the planted message, query `GET /messages/${WATCHDOG_DEFAULT_CHANNEL}` and observe a second entry with `type='lm_finding'` referring to the planted text via a `board#<id>` reference. Confirm a second `lm_inspections` row with `triggerKind='matcher'`, `outcome='finding'`, and `produced_message_id` matching the new entry.
6. **Plant a commit-message tripwire.** From an agent's worktree (or by hand on the bare repo via a temporary clone), make a commit on `docker/${PROJECT_ID}/agent-1` whose message body contains "scoped to a previous phase, will address later". Push the branch. Within `WATCHDOG_POLL_SECONDS`, confirm a third `lm_inspections` row with `triggerKind='matcher'` and the LM's body cites the commit via a `commit#<sha>` reference.
7. **Cursor advances.** Operator posts the same matcher phrase from step 4 to the message board again as a fresh message. Within `WATCHDOG_POLL_SECONDS`, confirm a new inspection only fires for the *new* message (cursor advanced past step 4's message ID; step 4's message will not re-trigger). The new message's matcher hit may or may not produce a finding depending on the LM's behavioural judgment about restating versus escalating — both outcomes are acceptable; the test asserts the cursor model, not the LM's choice.
8. **Orchestrator joined its engineer room.** Confirm the orchestrator container was launched with `CHAT_ROOM=engineers-${PROJECT_ID}`, registration logs show the existing room-join step returning 200, and `GET /rooms/engineers-${PROJECT_ID}` lists the orchestrator agent as a member.
9. **Plant an intervention.** Hand-call `POST /lm/interventions` from the dashboard with `inspectionId` referencing a real recent inspection, `targetAgentName=<orchestrator-name>`, `body="@orchestrator the test count regression at commit#<sha> is in this phase's diff per the safety review's file list — please re-run before advancing."`, `notifyOperator=false`. Confirm a row in `chat_messages` with `authorType='system'` in `engineers-${PROJECT_ID}`, the inspection's `produced_chat_message_id` updated to the new chat message ID, and (within ~60s of the orchestrator's next protocol poll point) the orchestrator's own `agent`-typed reply in the same room acknowledging the intervention.
10. **Email path.** With `RESEND_API_KEY` and `RESEND_FROM` set in the server's host environment and `operator_email` set on the project, hand-call `POST /lm/findings` from the dashboard with `notifyOperator: true` and `severity: 'pause'`. Confirm the operator receives an email; confirm one `lm_email_log` row with `reason='sent', ok=true` referencing the new `messages.id`; confirm `POST /coalesce/pause` was called (pump agents now `paused`).
11. **Email cooldown.** Within `RESEND_COOLDOWN_MINUTES`, hand-call `POST /lm/findings` again with `notifyOperator: true`. Confirm a second `lm_email_log` row with `reason='cooldown', ok=false` and **no** new email landed.
12. **Heartbeat clock reset.** Confirm that the next heartbeat fires `WATCHDOG_HEARTBEAT_SECONDS` after the most recent inspection (whichever from steps 5–11 was latest), not after step 3's.
13. **Idle shutdown.** Operator marks the test pump's pending task as `completed` and confirms `/coalesce/status` returns `canCoalesce: true`. Within `WATCHDOG_IDLE_SHUTDOWN_SECONDS + WATCHDOG_POLL_SECONDS`, confirm: a final `lm_shutdown` entry on `${WATCHDOG_DEFAULT_CHANNEL}`, the container exits cleanly with code 0 (`docker ps -a` shows `Exited (0)`), and the container has *not* restarted (compose `restart: "no"` honoured).

**Verification:**

- Operator walks the smoke test top to bottom and observes each enumerated outcome.
- All `lm_inspections` rows from the run have `outcome ∈ {'quiet', 'finding'}`, none have `outcome='error'`.
- The container's exit code is 0 and the container is not in a restarting state.
- Operator-run rebuild of the watchdog image succeeds: `docker compose -f container/docker-compose.yml build lm-watchdog`.
