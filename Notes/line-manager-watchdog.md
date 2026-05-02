# Line Manager Watchdog

## Goal
Add a long-running, project-scoped oversight agent that detects continuity gaps between pump-task units — most importantly test failures rationalised away as "scoped to a previous phase" — without burning Opus tokens on idle watching. The container runs a cheap always-on driver process and summons a fresh `claude -p` Opus session only when a tripwire fires or the heartbeat clock elapses.

## Context

- Pump containers run `claude -p` per task with fresh context. Quality per task is high, but cross-task drift slips through (TFs written off across phase boundaries, slop language passing review).
- Headless `claude -p` is request/response. Keeping a session "alive" between events would either burn tokens on heartbeats or waste the 5-minute prompt cache window. The watchdog is therefore not a long-running Claude session — it is a long-running driver process that summons short Opus sessions on signal.
- Haiku is **not** in the runtime path. Haiku is an upstream analysis tool the operator runs against the historical message corpus to surface candidate weasel phrases; the curated phrases land in a static matcher config. Runtime triage is regex/string matchers + numeric anomaly checks + (sometimes) Opus.
- Heartbeat fires Opus unconditionally — the point of the watchdog is to catch continuity gaps the matchers cannot articulate. The heartbeat clock measures "time since last Opus inspection of any kind", so a tripwire-triggered audit at minute 25 resets the clock and the next heartbeat fires 30 minutes after that, not at minute 30.
- The watchdog never pushes code. Its terminal action is always to post a finding to a chat room with a new `auditor` author type. Tier-1 ("note") is the default; Tier-2 ("pause") calls the existing `/coalesce/pause` endpoint when a finding is severe enough.
- One watchdog container per project. The container can fetch any branch in the bare repo (`docker/{project-id}/current-root` plus every `docker/{project-id}/{agent-name}`) into its own throwaway worktrees for diff inspection.
- The watchdog can ask the server to email the operator out-of-band for findings the operator should see immediately — the server holds the Resend API key, the container does not. This keeps the container's outbound media surface as narrow as possible.
- Out of scope for this plan: the Haiku-assisted historical sweep tool (separate one-shot tooling); operator dashboard UI for findings (the chat room already renders messages); promotion of the watchdog to a code-pushing role; notification channels other than email (SMS, Slack, push) — the email path is the v1 surface, additional channels are future plans.

<!-- PHASE-BOUNDARY -->

## Phase 1 — Schema additions for the watchdog

**Outcome:** The database accepts `auditor` as a value of [`server/src/schema/tables.ts`](../server/src/schema/tables.ts) `chatMessages.authorType`, persists every Opus inspection (so the heartbeat clock has a single source of truth across container restarts), and persists each emitted finding under a stable de-duplication key.

**Types / APIs:**

In [`server/src/schema/tables.ts`](../server/src/schema/tables.ts):

```ts
// Additive — existing values 'agent' | 'operator' | 'system' continue to work.
// Add 'auditor' as the watchdog's author type.

export const lmInspections = pgTable('lm_inspections', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  triggerKind: text('trigger_kind').notNull(), // 'heartbeat' | 'matcher' | 'anomaly' | 'mention'
  triggerDetail: text('trigger_detail'),       // free text — e.g. matcher key, anomaly metric
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  outcome: text('outcome').notNull(),          // 'quiet' | 'finding' | 'budget_exhausted' | 'error'
});

export const lmFindings = pgTable('lm_findings', {
  id: serial('id').primaryKey(),
  inspectionId: integer('inspection_id').notNull().references(() => lmInspections.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  dedupKey: text('dedup_key').notNull(),       // stable hash; see Work
  severity: text('severity').notNull(),        // 'note' | 'pause'
  title: text('title').notNull(),
  body: text('body').notNull(),
  postedRoomId: text('posted_room_id').references(() => rooms.id),
  postedMessageId: integer('posted_message_id').references(() => chatMessages.id),
  notifyOperator: boolean('notify_operator').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
// Unique index on (project_id, dedup_key) so the same finding is never re-emitted.
```

**Work:**

- Author one Drizzle migration under [`server/drizzle/`](../server/drizzle/) that adds `lm_inspections` and `lm_findings`. No constraint changes are required for `chat_messages.author_type` — the column is plain text.
- Add the new tables to [`server/src/schema/tables.ts`](../server/src/schema/tables.ts).
- The `dedupKey` is computed by the driver (Phase 4) as a SHA-256 hex of a stable tuple — for matcher hits: `(projectId, matcherKey, agentBranchHeadSha, messageId)`; for anomalies: `(projectId, anomalyKey, agentName, phaseId)`; for heartbeat findings: `(projectId, "heartbeat", agentBranchHeadSha, findingClass)`. The schema does not enforce structure on the key; uniqueness on `(project_id, dedup_key)` is the only invariant.

**Verification:**

- `npm run db:migrate` succeeds against a fresh PGlite.
- `npx tsx --test server/src/schema/` passes.
- A fresh hand-written test inserts one row into each table and reads it back; the unique index on `(project_id, dedup_key)` rejects a duplicate insert.

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
  recentMessages: Array<{
    id: number; roomId: string; authorType: string; authorAgentId: string | null;
    content: string; createdAt: string;
  }>;
  recentTasks: Array<{
    id: string; status: string; phaseId: string | null; agentName: string | null;
    startedAt: string | null; finishedAt: string | null; planPath: string | null;
  }>;
  recentBuilds: Array<{
    id: number; kind: 'build' | 'test'; success: boolean; exitCode: number;
    branch: string; startedAt: string; finishedAt: string;
  }>;
  priorFindings: Array<{ dedupKey: string; severity: string; title: string; createdAt: string }>;
  // priorFindings covers the past 24h so the audit can suppress re-flagging.
}

// POST /lm/inspections
interface RecordInspectionRequest {
  triggerKind: 'heartbeat' | 'matcher' | 'anomaly' | 'mention';
  triggerDetail?: string;
  startedAt: string;        // ISO8601
  finishedAt: string;       // ISO8601
  inputTokens: number;
  outputTokens: number;
  outcome: 'quiet' | 'finding' | 'budget_exhausted' | 'error';
}
interface RecordInspectionResponse { id: number; lastInspectionAt: string }

// POST /lm/findings
interface PostFindingRequest {
  inspectionId: number;
  dedupKey: string;
  severity: 'note' | 'pause';
  title: string;
  body: string;
  roomId: string;           // target chat room
  notifyOperator: boolean;  // true => server emails the operator (rate-limited, Phase 9)
}
interface PostFindingResponse {
  findingId: number;
  messageId: number;        // ID of the chat_messages row created with author_type='auditor'
  deduped: boolean;         // true if (project_id, dedup_key) already existed; no message posted
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
- `GET /lm/window` aggregates rows from the existing tables. The `since` query param defaults to "the latest `finishedAt` in `lmInspections` for this project, or now − 30 min if none". `recentMessages`/`recentTasks`/`recentBuilds` are bounded by `since` and a hard cap (200 rows each) so the bundle stays small.
- `POST /lm/findings` is the only place where the `auditor` author type is written — the route inserts a row into `chatMessages` with `authorType: 'auditor'` and `authorAgentId: null`, then inserts the finding row with `postedMessageId` set. If `(projectId, dedupKey)` already exists, the route returns `{deduped: true}` and posts no message.
- `GET /lm/state` reads the daily budget from project config (Phase 8) and sums tokens from today's `lmInspections` rows.

**Verification:**

- New test file [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts) using [`server/src/drizzle-test-helper.ts`](../server/src/drizzle-test-helper.ts) covers: window aggregation respects `since`, inspection insert returns the new row's ID and `lastInspectionAt`, finding insert posts a message with `authorType='auditor'`, finding insert with a duplicate `dedupKey` returns `{deduped: true}` and posts no message, state reflects today's token sum.
- `npm test` green for the server package.

<!-- PHASE-BOUNDARY -->

## Phase 3 — Watchdog container service in compose

**Outcome:** `launch.sh` (or an equivalent invocation) can start a `lm-watchdog` container per project alongside the existing pump containers. The container starts, registers nothing on the agents table (the watchdog is not an agent — its identity is `auditor`), and idles in its driver loop.

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
      - WATCHDOG_DEFAULT_ROOM=${WATCHDOG_DEFAULT_ROOM:-general}
      - WATCHDOG_AGENT_TYPE=${WATCHDOG_AGENT_TYPE:-lm-watchdog}
    volumes:
      - ${BARE_REPO_PATH:?Set BARE_REPO_PATH}:/repo.git:ro
      - ${LOGS_PATH:-./logs}:/logs
      - ${CLAUDE_CREDENTIALS_PATH:?Set CLAUDE_CREDENTIALS_PATH}:/home/claude/.claude/.credentials.json:ro
      - ${AGENTS_PATH:-../agents}:/staged-agents:ro
      - watchdog-workspace:/workspace
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  watchdog-workspace:
```

**Work:**

- Add a new [`container/Dockerfile.watchdog`](../container/Dockerfile.watchdog) layered on the existing container image. It installs Node ≥ 20 (already present), copies the driver source (Phase 4) under `/opt/watchdog`, and sets `ENTRYPOINT ["/opt/watchdog/entrypoint.sh"]`.
- Bare repo mount is **read-only**. The driver does its own `git clone /repo.git /workspace/repo` on first start so it has a writable working tree for `git fetch` + worktree creation, without ever pushing anything back.
- The watchdog does **not** call `POST /agents/register`. It is identified solely by `author_type='auditor'` on chat messages.
- Update [`scripts/launch-team.sh`](../scripts/launch-team.sh) and the relevant compose-detect helper in [`scripts/lib/compose-detect.sh`](../scripts/lib/compose-detect.sh) to recognise `lm-watchdog` as a known service. Launch path: `./launch.sh --watchdog` brings up only the watchdog service for the resolved project.
- Container start-up steps in [`container/Dockerfile.watchdog`](../container/Dockerfile.watchdog)'s entrypoint: validate env, ensure `/workspace/repo` exists (clone if not), then `exec node /opt/watchdog/dist/main.js`.

**Verification:**

- `bash -n` clean on every modified shell script.
- Operator runs `./launch.sh --watchdog --dry-run` and observes a resolved compose file containing the new service with the correct env and volume mounts.
- Operator runs `./launch.sh --watchdog`, container starts, `docker logs` shows the driver entering its idle loop, and the container persists for at least one heartbeat interval. (See Phase 9 for the full smoke test.)

<!-- PHASE-BOUNDARY -->

## Phase 4 — Watchdog driver process

**Outcome:** A Node TypeScript process running inside the watchdog container loops forever, polling the server every `WATCHDOG_POLL_SECONDS`, applies triage rules (Phase 5), decides whether to invoke an audit (Phase 6), records the inspection via `POST /lm/inspections`, and posts findings via `POST /lm/findings`. Process is restart-safe — all durable state lives on the server.

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
  defaultRoom: string;
  workspaceRepoPath: string;
}
async function runDriver(client: ServerClient, cfg: DriverConfig): Promise<never>;
// Loop:
//   1. Sleep pollSeconds.
//   2. Fetch window + state.
//   3. Decide nextTrigger via shouldAudit(window, state, lastInspectionAt, heartbeatSeconds).
//   4. If trigger: run audit (Phase 6), record inspection, optionally post finding.
//   5. Repeat.

// container/watchdog/src/triggers.ts
type Trigger =
  | { kind: 'none' }
  | { kind: 'heartbeat' }
  | { kind: 'matcher'; matcherKey: string; messageId: number }
  | { kind: 'anomaly'; anomalyKey: string; detail: string }
  | { kind: 'mention'; messageId: number };

function shouldAudit(args: {
  window: LmWindowResponse;
  state: LmStateResponse;
  lastInspectionAt: string | null;
  heartbeatSeconds: number;
}): Trigger;
```

**Work:**

- Set up [`container/watchdog/package.json`](../container/watchdog/package.json) with the same ESM/Node ≥ 20 conventions used by the server (TypeScript, `tsx` for dev, `tsc` for build).
- The driver's "last inspection" cursor is recovered on startup from `GET /lm/state`. Container restarts are therefore stateless — the heartbeat clock is server-truth, not local truth.
- All HTTP requests carry `X-Project-Id: ${PROJECT_ID}`. Server-side scoping (already enforced by [`server/src/plugins/project-id.ts`](../server/src/plugins/project-id.ts)) keeps the watchdog confined to its project.
- The driver is the only consumer of the Phase 2 endpoints. No other service writes to `lm_inspections` / `lm_findings`.

**Worked example — heartbeat clock arithmetic.** Heartbeat is *time since last inspection of any kind*, not *time since last heartbeat*. Concrete trace with `WATCHDOG_HEARTBEAT_SECONDS=1800` (30 min):

- T+0: container starts, `lastInspectionAt=null`, driver fires a heartbeat audit immediately, server records inspection finishing at T+0:02.
- T+0:25: a matcher tripwire fires, audit runs and records inspection finishing at T+0:27.
- T+0:50: driver polls. `now − lastInspectionAt = 23 min < 30 min`. **No heartbeat.** Correct.
- T+0:57: driver polls. `now − lastInspectionAt = 30 min`. Heartbeat fires.

Inverted arithmetic (heartbeat measured from previous heartbeat instead of from last inspection) would have re-fired at T+0:30 right after the matcher audit completed at T+0:27 — three minutes of redundant Opus work. The arithmetic gate is `now − lastInspectionAt ≥ heartbeatSeconds`, **not** `now − lastHeartbeatAt ≥ heartbeatSeconds`.

**Verification:**

- Unit tests for [`container/watchdog/src/driverLoop.test.ts`](../container/watchdog/src/driverLoop.test.ts) and [`container/watchdog/src/triggers.test.ts`](../container/watchdog/src/triggers.test.ts) using fake clocks. Coverage: heartbeat fires when and only when `now − lastInspectionAt ≥ heartbeatSeconds`; tripwire-fired audits reset the clock; multiple tripwires within a single poll cycle pick the highest-priority trigger (mention > matcher > anomaly > heartbeat).
- `npm test` green inside [`container/watchdog/`](../container/watchdog/).

<!-- PHASE-BOUNDARY -->

## Phase 5 — Triage rules: matchers, anomalies, mentions

**Outcome:** The driver decides whether new activity in the window justifies an Opus audit. Three rule families run on every poll: regex/string matchers over message and commit text, numeric anomaly checks over phase durations and diff sizes, and direct-mention detection. A trigger is emitted when any rule fires; the heartbeat is the fallback when no rule fires.

**Types / APIs:**

```ts
// container/watchdog/src/matchers.ts
interface MatcherConfig {
  // Loaded from /opt/watchdog/matchers.json at container start; hot-reload not required.
  phrases: Array<{
    key: string;          // stable identifier, e.g. 'scoped_to_previous_phase'
    pattern: string;      // case-insensitive regex
    severity: 'note' | 'pause';
  }>;
}
function findMatcherHits(msgs: LmWindowResponse['recentMessages'], cfg: MatcherConfig): Array<{
  matcherKey: string; messageId: number; severity: 'note' | 'pause';
}>;

// container/watchdog/src/anomalies.ts
interface AnomalyHit { anomalyKey: string; detail: string; severity: 'note' | 'pause' }
function findAnomalies(window: LmWindowResponse): AnomalyHit[];
// Initial rule set:
//   - phase_too_fast: a task transitioned to 'completed' in < 60s of wall-clock time
//     since 'in_progress'. Severity 'note'.
//   - test_failure_count_increased: most recent test build for an agent has more
//     failures than its previous test build on the same branch. Severity 'pause'.
//   - diff_size_outlier: most recent commit on an agent branch touched > 50 files
//     OR > 2000 added lines. Severity 'note'.
// Thresholds live alongside the matcher config in /opt/watchdog/anomalies.json.

// container/watchdog/src/mentions.ts
function findMentions(msgs: LmWindowResponse['recentMessages'], watchdogHandle: string): number[];
// watchdogHandle defaults to 'lm' / '@lm' / 'line manager' (case-insensitive).
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

**Worked example — `test_failure_count_increased` direction.** This is the most sign-sensitive rule in the set. Concrete trace:

- Agent `agent-1` built at T+0 with 3 test failures.
- Agent `agent-1` built at T+1 with 5 test failures.
- `5 > 3`, the count *increased*, the agent committed something between T+0 and T+1 that worsened the suite — fire the anomaly.
- Inverted form (`prev > now`) would only fire when the failure count *decreased*, which is the opposite of slop and would silence the very signal we built the rule for.
- The comparison is `now.failures > prev.failures` on the **same branch**, **most recent two builds**. Builds on different branches do not compare. A build with `success=true` has `failures=0`.

**Verification:**

- Unit tests in [`container/watchdog/src/matchers.test.ts`](../container/watchdog/src/matchers.test.ts), [`container/watchdog/src/anomalies.test.ts`](../container/watchdog/src/anomalies.test.ts), [`container/watchdog/src/mentions.test.ts`](../container/watchdog/src/mentions.test.ts).
- The matcher test asserts each seeded phrase fires on a positive sample and does not fire on a hand-crafted near-miss (e.g. `scoped_to_previous_phase` does not fire on "this is scoped to the current phase").
- The anomaly test asserts `test_failure_count_increased` fires for `(prev=3, now=5)` and does not fire for `(prev=5, now=3)` or `(prev=3, now=3)`.

<!-- PHASE-BOUNDARY -->

## Phase 6 — Audit invocation: bundle, claude -p, emit finding

**Outcome:** When a trigger fires, the driver assembles a context bundle, invokes a fresh Opus session via `claude -p` with the watchdog agent definition (Phase 7), parses the response, and posts at most one finding to the configured chat room with `authorType='auditor'`. Quiet outcomes record the inspection but post no message, except on heartbeat (a single-line "all quiet" message is always posted on heartbeat to confirm the watchdog is alive).

**Types / APIs:**

```ts
// container/watchdog/src/audit.ts
interface AuditContext {
  trigger: Trigger;
  window: LmWindowResponse;
  workspace: { repoPath: string; branchHeads: Record<string, string> };
  // branchHeads[agentName] is the most recent commit SHA observed on
  // docker/{projectId}/{agentName} after the driver fetched the bare repo.
  recentDiffs: Array<{
    agentName: string; sinceSha: string; nowSha: string;
    filesChanged: number; insertions: number; deletions: number;
    truncatedDiffText: string; // first 4000 chars of `git diff sinceSha..nowSha`
  }>;
  priorFindings: LmWindowResponse['priorFindings'];
}

interface AuditResult {
  outcome: 'quiet' | 'finding' | 'budget_exhausted' | 'error';
  finding?: {
    dedupKey: string;
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
  1. `git -C /workspace/repo fetch /repo.git '+refs/heads/docker/${PROJECT_ID}/*:refs/heads/docker/${PROJECT_ID}/*'` to refresh known agent branches.
  2. For each agent in `window.agents`, capture the head SHA and produce a diff against the project's seed branch `docker/${PROJECT_ID}/current-root`, capped at 4000 characters.
  3. Sample messages: include the **tail** of `recentMessages` (the last 5) plus a uniform random sample of up to 15 more from the remainder.
  4. Build the prompt using the watchdog agent definition (Phase 7) plus the JSON-serialised bundle.
- Invocation: spawn `claude -p` as a child process with stdin = prompt and `--output-format json` so token counts are recoverable. Honour `CLAUDE_CREDENTIALS_PATH` from the existing mount.
- The audit response is a JSON envelope (defined in Phase 7) the driver parses to produce `AuditResult`.
- On heartbeat with `outcome='quiet'`: post a one-line message ("LM heartbeat — quiet, no findings") to `WATCHDOG_DEFAULT_ROOM` with `authorType='auditor'`. On any other trigger with `outcome='quiet'`: record the inspection but post nothing.
- On `outcome='finding'`: compute `dedupKey` and call `POST /lm/findings`. If the server returns `{deduped: true}`, the driver records the inspection but no message lands — preventing alert fatigue when the same incident re-trips a wire on consecutive cycles.
- On `outcome='budget_exhausted'`: post a one-line message once per UTC day, then short-circuit subsequent audits to a no-op until the day rolls over.

**Verification:**

- Tests in [`container/watchdog/src/audit.test.ts`](../container/watchdog/src/audit.test.ts) using a fake `claude -p` (a stub binary on `PATH`) that returns canned JSON envelopes for `quiet`, `finding`, and `error` cases.
- Coverage: heartbeat-quiet posts one message; non-heartbeat-quiet posts none; finding-with-new-dedup-key posts one message; finding-with-existing-dedup-key posts none; budget exhaustion posts once per day; malformed audit JSON yields `outcome='error'` and an inspection row with `outcome='error'`.

<!-- PHASE-BOUNDARY -->

## Phase 7 — Watchdog agent definition

**Outcome:** A new agent definition under [`dynamic-agents/lm-watchdog.md`](../dynamic-agents/lm-watchdog.md), compiled by [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) into `agents/lm-watchdog.md`, defines the persona Opus runs under during an audit and the JSON output contract the driver expects.

**Types / APIs:**

The agent's response format is constrained to a single JSON object:

```json
{
  "outcome": "quiet" | "finding",
  "finding": {
    "severity": "note" | "pause",
    "title": "<short, specific>",
    "body": "<2-6 sentences; cites concrete agent names, branches, and message IDs>",
    "notifyOperator": true | false
  } | null,
  "rationale": "<one paragraph; the LM's reasoning, kept for the inspection log>"
}
```

**Work:**

- Author [`dynamic-agents/lm-watchdog.md`](../dynamic-agents/lm-watchdog.md) covering: read-only role; the LM never pushes code or invokes tools that mutate repo state; quiet-discipline output (single line for "all quiet"); how to weight the bundle (recent test failure deltas dominate; matcher hits are pre-flagged for second-guessing, not blind acceptance; phase-too-fast anomalies require corroboration in commit content before promoting to a finding); when to choose `severity='pause'` vs `'note'` (pause only for safety/correctness regressions that would compound across subsequent phases — a test suite getting worse, deletion or `.skip` of test files, agent commits touching files outside the task's declared scope); when to set `notifyOperator=true` (every `severity='pause'` finding sets it, since the operator should know when work is paused; `severity='note'` findings set it only when sustained drift is observed — the same dedup-class incident has been noted in two consecutive inspections without operator action).
- The agent definition lists only the tools needed: `Read`, `Grep`, `Bash` (for `git log` / `git diff` inspection inside the watchdog's read-only worktree). No `Edit`, no `Write`, no network.
- The output contract is restated verbatim at the end of the agent file. The driver parses the last fenced JSON block in the response.
- Verify [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) compiles the new file into `agents/lm-watchdog.md` without manual intervention. Per the compilation memory, do not run the compile script by hand — exercise it via the existing automated path (test or launch).

**Verification:**

- New entry exists in `agents/` after compilation runs.
- A hand-run audit (driven by Phase 9's smoke test) returns a valid JSON envelope; the driver's parser accepts it without error.

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
- Tier-2 escalation: after `POST /lm/findings` succeeds with `severity='pause'` and `deduped=false`, the driver immediately calls `POST /coalesce/pause` (existing endpoint at [`server/src/routes/coalesce.ts`](../server/src/routes/coalesce.ts) line 71). Pause is therefore audit-side-effectful but bounded — only a brand-new pause-class finding triggers it.

**Worked example — pause severity gating.** The user explicitly does not want the watchdog over-pausing the project. Concrete trace:

- Audit returns `severity='pause'` for "test_failure_count_increased on agent-1, count went 3 → 5". `dedup_key` is new. `POST /coalesce/pause` is called once. Pump pauses.
- Operator investigates, resumes pumps, agent-1 lands a fix, next test build shows 5 → 2 failures.
- The watchdog's next audit window includes the same `(agent-1, branch=…)` context. The matcher does not fire (failures *decreased*), no new pause finding is generated, no second pause call is made.
- Even if the operator did nothing and the same `severity='pause'` finding would land again on the next audit, the dedup index on `(project_id, dedup_key)` returns `deduped=true`, no message posts, and no pause call is made. Pause is therefore at-most-once per distinct incident.

**Verification:**

- Tests in [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts): budget-exhausted state computed correctly; budget reset behaviour at UTC midnight (use a fake clock).
- Tests in [`container/watchdog/src/audit.test.ts`](../container/watchdog/src/audit.test.ts): `severity='pause'` with `deduped=false` triggers the pause call exactly once; `deduped=true` does not call pause; `outcome='budget_exhausted'` does not invoke `claude -p`.

<!-- PHASE-BOUNDARY -->

## Phase 9 — Out-of-band operator notification via Resend

**Outcome:** When a finding lands with `notifyOperator: true`, the server sends a plain-text email to the project's configured operator address via the Resend HTTP API. Cooldown and a daily cap prevent flooding. The watchdog container never holds the Resend API key — it only sets a flag on the finding. If notification is requested but cannot be sent (no address configured, no API key, cooldown, daily cap reached), the response carries the reason and the inspection still records as `outcome='finding'` with the chat-room message intact.

**Types / APIs:**

Schema additions in [`server/src/schema/tables.ts`](../server/src/schema/tables.ts):

```ts
// Additive column on the existing 'projects' table.
operatorEmail: text('operator_email'),
// Null disables operator email for the project even when notifyOperator=true.

// New table.
export const lmEmailLog = pgTable('lm_email_log', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  findingId: integer('finding_id').notNull().references(() => lmFindings.id, { onDelete: 'cascade' }),
  sentAt: timestamp('sent_at').notNull().defaultNow(),
  resendId: text('resend_id'),         // ID returned by Resend; null on failure or skip
  ok: boolean('ok').notNull(),         // true = email accepted by Resend; false = error or skipped
  reason: text('reason').notNull(),    // 'sent' | 'cooldown' | 'no_address' | 'no_api_key' | 'error'
  errorBody: text('error_body'),
});
```

Server-host environment (never reaches the container):

```
RESEND_API_KEY=<resend api key>
RESEND_FROM=lm@<your-domain>
RESEND_COOLDOWN_HOURS=24            # default 24
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
- Inside [`server/src/routes/lm.ts`](../server/src/routes/lm.ts), `POST /lm/findings` performs the email side-effect *after* the finding row inserts and *only if* `notifyOperator: true` and `deduped: false`. The deduped path skips email entirely — a re-emit of the same finding is not the operator's problem.
- Email gating is checked in this fixed order; first failing check wins:
  1. `RESEND_API_KEY` unset on the host → `reason='no_api_key'`.
  2. `projects.operator_email` null → `reason='no_address'`.
  3. Most recent successful `lm_email_log` row for `(projectId, finding.dedupKey)` is more recent than `now − RESEND_COOLDOWN_HOURS` → `reason='cooldown'`.
  4. Count of `lm_email_log` rows for `projectId` since today's UTC midnight where `ok=true` and `reason='sent'` is at least `RESEND_DAILY_CAP` → `reason='cooldown'` (cap-driven cooldown, same outcome shape).
  5. Otherwise call `sendOperatorEmail`. On HTTP success → `reason='sent'`, `ok=true`. On HTTP error → `reason='error'`, `ok=false`, `errorBody` set. Either way insert one `lm_email_log` row.
- Subject line: `[LM ${projectId}] ${title}`. Body is plain text containing: project ID, finding title, finding body, severity, dedup key, inspection ID, link to the chat room (if a dashboard URL is configured in project config — otherwise omit).
- The Resend wrapper performs no retries. A failed send lands in `lm_email_log` with `ok=false`; the operator inspects the log to triage. The route returns `emailed=false, emailReason='error'` to the watchdog so the inspection record correctly captures the attempt.
- Every email decision (skip or send, success or failure) lands in `lm_email_log` so the operator has a complete audit trail of what the LM tried to send and why.

**Worked example — cooldown direction.** The cooldown gate is sign-sensitive: cooldown is "time *since* last successful send", not "time *until* next allowed send". Concrete trace with `RESEND_COOLDOWN_HOURS=24`:

- T+0:00: finding F1 with `dedupKey=K1`, `notifyOperator=true`. No prior `lm_email_log` for K1. `now − lastSentAt` is undefined → treated as ≥ 24h. Send. New row `(K1, sentAt=T+0:00, ok=true, reason='sent')`.
- T+0:30: a different finding F2 with `dedupKey=K2`. No prior log for K2. Send. Independent of K1.
- T+0:45: a near-duplicate finding F3 with the same `dedupKey=K1` is somehow generated (driver bug, manual server insert). The finding-level dedup index returns `deduped=true`, so the email side-effect is skipped before any cooldown check runs.
- T+1:00: in a hypothetical where F3 had a *new* dedup key but covered the same incident, cooldown is checked. `now − lastSentAt(K1) = 1h`. `1h < 24h ⇒ skip`. `reason='cooldown'`.
- T+24:01: same K1 incident re-occurs with a new dedup key (e.g. on a new commit SHA). `now − lastSentAt(K1) = 24h 1min`. `24h 1min ≥ 24h ⇒ send`.

The arithmetic gate is `now − lastSentAt ≥ cooldownWindow ⇒ allow send`. The inverted form (`now − lastSentAt > cooldownWindow ⇒ skip`) would only ever send the *first* email and silently swallow every subsequent one — the opposite of the goal.

**Verification:**

- New tests in [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts) using a fake Resend wrapper and fake clock. Coverage:
  - `notifyOperator=true` + `operatorEmail` set + key set + first time → email sent, `lm_email_log` row with `reason='sent', ok=true`, response `emailed=true, emailReason='sent'`.
  - `notifyOperator=true` + `operatorEmail=null` → response `emailed=false, emailReason='no_address'`, log row `reason='no_address', ok=false`.
  - `notifyOperator=true` + `RESEND_API_KEY` unset → response `emailed=false, emailReason='no_api_key'`, log row `reason='no_api_key', ok=false`.
  - Same `dedupKey` within 24 h that bypasses finding dedup (synthetic) → response `emailReason='cooldown'`.
  - 11th send within the same UTC day → response `emailReason='cooldown'`.
  - Resend HTTP failure → response `emailReason='error'`, log row carries `errorBody`.
  - `notifyOperator=false` → response `emailed=false, emailReason='not_requested'`, no log row created.
- New tests in [`server/src/integrations/resend.test.ts`](../server/src/integrations/resend.test.ts) for the wrapper: success path returns `{ok: true, resendId}`, error path returns `{ok: false, errorBody}`.

<!-- PHASE-BOUNDARY -->

## Phase 10 — End-to-end smoke test

**Outcome:** The operator can launch a watchdog against a real project, observe one heartbeat audit producing an "all quiet" message, plant a synthetic matcher phrase in a chat room and observe a tripwire-driven audit producing a finding, and confirm both inspections are recorded in `lm_inspections`.

**Types / APIs:** None — this phase is the operator-run verification of the integrated system.

**Work:**

Document the smoke test in [`container/watchdog/SMOKE.md`](../container/watchdog/SMOKE.md):

1. **Preconditions.** Coordination server running on `${SERVER_PORT}`. A pump container has been launched at least once for the chosen project so `docker/${PROJECT_ID}/current-root` exists. `WATCHDOG_HEARTBEAT_SECONDS=120` (lowered for the test) in the operator's `.env`.
2. **Boot watchdog.** `./launch.sh --watchdog --project <id>`. Verify with `docker ps` that the `lm-watchdog` service is up. Tail container logs.
3. **First heartbeat.** Within `WATCHDOG_HEARTBEAT_SECONDS + WATCHDOG_POLL_SECONDS` of boot, observe in the configured chat room a message from `authorType='auditor'` reading "LM heartbeat — quiet, no findings". Confirm one row in `lm_inspections` with `triggerKind='heartbeat'`, `outcome='quiet'`.
4. **Plant a tripwire.** Operator posts a message in the configured chat room reading "Test failures here are pre-existing — already broken before this phase." This contains both `pre_existing_failure` and `already_broken` matcher phrases.
5. **Tripwire audit.** Within `WATCHDOG_POLL_SECONDS` of the planted message, observe a second `authorType='auditor'` message — a finding referring to the planted text. Confirm a second `lm_inspections` row with `triggerKind='matcher'`, an `lm_findings` row with the matching `dedupKey`, and that the `auditor` message ID matches `lm_findings.posted_message_id`.
6. **Email path.** With `RESEND_API_KEY` and `RESEND_FROM` set in the server's host environment and `operator_email` set on the project, plant a synthetic `severity='pause'` finding (post a message strong enough to trigger the `test_failure_count_increased`-class language plus a planted matcher phrase, or hand-call `POST /lm/findings` from the dashboard with `notifyOperator: true`). Confirm the operator receives an email; confirm one `lm_email_log` row with `reason='sent', ok=true`. Repeat the trigger immediately and confirm a second `lm_email_log` row with `reason='cooldown'`.
7. **De-dup check.** Operator posts the same matcher message from step 4 again. Within `WATCHDOG_POLL_SECONDS`, confirm a new `lm_inspections` row exists, but **no** new `lm_findings` row, **no** new auditor message in the chat room, and **no** new `lm_email_log` row.
8. **Heartbeat clock reset.** Confirm that the next heartbeat fires `WATCHDOG_HEARTBEAT_SECONDS` after the most recent inspection (the one from step 5 or step 6, whichever is later), not after step 3's.
9. **Teardown.** `./stop.sh --watchdog --project <id>`. Confirm container stops cleanly.

**Verification:**

- Operator walks the smoke test top to bottom and observes each enumerated outcome.
- All `lm_inspections` rows from the run have `outcome ∈ {'quiet', 'finding'}`, none have `outcome='error'`.
- Operator-run rebuild of the watchdog image succeeds: `docker compose -f container/docker-compose.yml build lm-watchdog`.
