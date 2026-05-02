# Line Manager Watchdog

## Goal
Add a long-running, project-scoped oversight agent that detects continuity gaps between pump-task units — most importantly test failures rationalised away as "scoped to a previous phase" — without burning Opus tokens on idle watching. The container runs a cheap always-on driver process and summons a fresh `claude -p` Opus session only when a tripwire fires or the heartbeat clock elapses.

## Context

- Pump containers run `claude -p` per task with fresh context. Quality per task is high, but cross-task drift slips through — most importantly, test failures that one phase caused get rationalised away by a later phase as "out of scope" or "pre-existing", a pattern that gets worse when anomalous container shutdown and restart blurs the phase boundary. The watchdog also has to tolerate legitimate test-failure increases (TDD red-phase, deliberately failing tests committed before the implementation lands), so a raw failure-count delta is a *trigger for an audit*, not a finding on its own — corroborating evidence (commit messages, files touched, rationalisation language) is what promotes the trigger to a finding.
- Headless `claude -p` is request/response. Keeping a session "alive" between events would either burn tokens on heartbeats or waste the 5-minute prompt cache window. The watchdog is therefore not a long-running Claude session — it is a long-running driver process that summons short Opus sessions on signal.
- Haiku is **not** in the runtime path. Haiku is an upstream analysis tool the operator runs against the historical message corpus to surface candidate weasel phrases; the curated phrases land in a static matcher config. Runtime triage is regex/string matchers + numeric anomaly checks + (sometimes) Opus.
- Heartbeat fires Opus unconditionally — the point of the watchdog is to catch continuity gaps the matchers cannot articulate. The heartbeat clock measures "time since last Opus inspection of any kind", so a tripwire-triggered audit at minute 25 resets the clock and the next heartbeat fires 30 minutes after that, not at minute 30.
- The watchdog never pushes code. Its terminal action is always to post a finding to a server message-board channel via `POST /messages`, mirroring how orchestrators post their debriefs. Tier-1 ("note") is the default; Tier-2 ("pause") calls the existing `/coalesce/pause` endpoint when a finding is severe enough.
- Chat rooms (`/rooms/*`) are reserved for cases where the watchdog needs to actively contact a specific running agent to intervene in their reasoning. That "tag-in" capability is out of scope for this plan and is a future extension built on top of the existing rooms endpoints; v1 reads room messages for matcher input but never posts into them.
- One watchdog container per project, lifecycle scoped to active work. The container starts when the operator launches a pump or worker for the project and shuts itself down when the project goes idle (no active or pending tasks, all pump agents idle, no inspection in flight) for a configured grace window. The watchdog therefore never runs while nothing is happening — there is no need to design around long-idle windows.
- Triggers are one-shot per piece of evidence. The driver tracks cursors (last seen message ID on every channel and chat room, last seen build ID, last seen task transition timestamp) so a given matcher phrase, anomaly, or mention fires exactly once. There is no schema-level dedup on findings — the driver's cursors prevent the flood, and the LM's behavioural judgment handles the remaining edge cases (a window genuinely justifies a re-emit only when the LM decides so, e.g. severity escalation).
- A 30-minute heartbeat window with zero new evidence — no agent commits, no UE builds, no posted messages — is itself a red flag worth escalating. The LM must not return `quiet` on an empty window: an active project with no activity for half an hour is either stuck or hiding work, and that's a finding.
- The container can fetch any branch in the bare repo (`docker/{project-id}/current-root` plus every `docker/{project-id}/{agent-name}`) into its own throwaway worktrees for diff inspection.
- The watchdog can ask the server to email the operator out-of-band for findings the operator should see immediately — the server holds the Resend API key, the container does not. This keeps the container's outbound media surface as narrow as possible.
- Out of scope for this plan: the Haiku-assisted historical sweep tool (separate one-shot tooling); operator dashboard UI for findings (the existing message-board view already renders entries on the configured channel); promotion of the watchdog to a code-pushing role; the "tag-in" path where the watchdog posts into a chat room to interrupt a running agent; notification channels other than email (SMS, Slack, push) — the email path is the v1 surface, additional channels are future plans.

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
  // Set when outcome ∈ {'finding', 'quiet' on heartbeat, 'budget_exhausted'} and the
  // driver successfully posts to the message board. Null otherwise.
});
```

**Work:**

- Author one Drizzle migration under [`server/drizzle/`](../server/drizzle/) that adds `lm_inspections`.
- Add the new table to [`server/src/schema/tables.ts`](../server/src/schema/tables.ts).
- No findings table, no dedup_key, no severity column. Severity, title, body, and any auditor-specific structured data live on `messages.payload` for rows with `type='lm_finding'`. The audit-trail link inspection → message goes through `lm_inspections.produced_message_id`.

**Verification:**

- `npm run db:migrate` succeeds against a fresh PGlite.
- `npx tsx --test server/src/schema/` passes.
- A fresh hand-written test inserts an inspection row, then a `messages` row with `type='lm_finding'`, sets `produced_message_id` on the inspection, and reads back the join.

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
  recentRoomMessages: Array<{
    id: number; roomId: string; authorType: string; authorAgentId: string | null;
    content: string; createdAt: string;
  }>;
  recentBoardMessages: Array<{
    id: number; channel: string; fromAgent: string; type: string;
    payload: unknown; createdAt: string;
  }>;
  recentTasks: Array<{
    id: string; status: string; phaseId: string | null; agentName: string | null;
    startedAt: string | null; finishedAt: string | null; planPath: string | null;
  }>;
  recentBuilds: Array<{
    id: number; kind: 'build' | 'test'; success: boolean; exitCode: number;
    branch: string; startedAt: string; finishedAt: string;
  }>;
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
- `GET /lm/window` aggregates rows from the existing tables. The `since` query param defaults to "the latest `finishedAt` in `lmInspections` for this project, or now − 30 min if none". Each row collection (`recentRoomMessages`, `recentBoardMessages`, `recentTasks`, `recentBuilds`) is bounded by `since` and a hard cap (200 rows each) so the bundle stays small. `recentBoardMessages` includes orchestrator debriefs, prior LM findings, and any other agent output posted via `POST /messages`; the watchdog scans it for matcher hits alongside `recentRoomMessages` and uses prior LM findings as memory of what has already been flagged.
- `POST /lm/findings` posts to the server message board, mirroring how orchestrators post their debriefs. The route inserts a row into `messages` via `msgQ.insert` with `channel` from the request, `type='lm_finding'`, and `fromAgent` taken from the request's `X-Agent-Name` header (the watchdog sets this to its configured identity, e.g. `lm-watchdog`). The `payload` carries the structured finding (`severity`, `title`, `body`, `inspectionId`). After the message inserts, the route updates the corresponding `lm_inspections` row's `produced_message_id` to the new `messages.id`. No dedup check — the driver guarantees one trigger per piece of evidence (Phase 5).
- `GET /lm/state` reads the daily budget from project config (Phase 8) and sums tokens from today's `lmInspections` rows.

**Verification:**

- New test file [`server/src/routes/lm.test.ts`](../server/src/routes/lm.test.ts) using [`server/src/drizzle-test-helper.ts`](../server/src/drizzle-test-helper.ts) covers: window aggregation respects `since` and includes both room and board messages, inspection insert returns the new row's ID and `lastInspectionAt`, finding insert posts a message-board entry with `type='lm_finding'` and `fromAgent` matching the request's `X-Agent-Name` header, finding insert updates the inspection's `produced_message_id`, state reflects today's token sum.
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
      - WATCHDOG_AGENT_TYPE=${WATCHDOG_AGENT_TYPE:-lm-watchdog}
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

**Outcome:** A Node TypeScript process running inside the watchdog container loops, polling the server every `WATCHDOG_POLL_SECONDS`, applies triage rules (Phase 5), decides whether to invoke an audit (Phase 6), records the inspection via `POST /lm/inspections`, and posts findings via `POST /lm/findings`. The driver exits cleanly when the project has been idle for `WATCHDOG_IDLE_SHUTDOWN_SECONDS`. Durable state (heartbeat clock, token budget) lives on the server. Cursor state (last seen message ID per channel/room, last seen build ID, last seen task transition timestamp) lives in-memory on the driver — restart-safe because on restart the driver simply scans the window from the latest server-recorded inspection forward, and the LM's first audit on the new run sees the full bundle since then.

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
  lastBoardMessageId: number;       // largest message_id from POST /messages observed
  lastRoomMessageId: number;        // largest chat_messages.id observed
  lastBuildId: number;              // largest build_history.id observed
}

async function runDriver(client: ServerClient, cfg: DriverConfig): Promise<void>;
// Loop:
//   1. Sleep pollSeconds.
//   2. Fetch coalesce status; if project has been idle for >= idleShutdownSeconds,
//      log shutdown reason and return (container exits with code 0).
//   3. Fetch window + state.
//   4. Filter window to evidence newer than cursors.
//   5. Decide nextTrigger via shouldAudit(filteredWindow, state, lastInspectionAt,
//      heartbeatSeconds, staleWindowSeconds).
//   6. If trigger: run audit (Phase 6), record inspection, optionally post finding,
//      advance cursors past the evidence consumed.
//   7. Repeat.

// container/watchdog/src/triggers.ts
type Trigger =
  | { kind: 'none' }
  | { kind: 'heartbeat' }
  | { kind: 'matcher'; matcherKey: string; source: 'room' | 'board'; messageId: number }
  | { kind: 'anomaly'; anomalyKey: string; detail: string }
  | { kind: 'mention'; source: 'room' | 'board'; messageId: number }
  | { kind: 'stale_window'; sinceSeconds: number };

function shouldAudit(args: {
  window: LmWindowResponse;
  state: LmStateResponse;
  lastInspectionAt: string | null;
  heartbeatSeconds: number;
  staleWindowSeconds: number;
}): Trigger;
// Priority within a single poll: mention > matcher > anomaly > stale_window > heartbeat.
// stale_window fires only when a heartbeat is due AND the window has zero new evidence
// since the last inspection. This is itself a finding (Phase 7), not a quiet heartbeat.
```

**Work:**

- Set up [`container/watchdog/package.json`](../container/watchdog/package.json) with the same ESM/Node ≥ 20 conventions used by the server (TypeScript, `tsx` for dev, `tsc` for build).
- The driver's "last inspection" cursor is recovered on startup from `GET /lm/state`. Container restarts are therefore stateless on the heartbeat clock — server is truth. Per-evidence cursors (`lastBoardMessageId`, `lastRoomMessageId`, `lastBuildId`) start at zero on each container run; the first poll after start fetches the full window and the LM's first audit sees everything since the last server-recorded inspection. Subsequent polls in the same run advance the cursors past evidence already consumed.
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

**Outcome:** The driver decides whether new activity in the window justifies an Opus audit. Three rule families run on every poll over the *cursor-filtered* slice of the window (only evidence newer than `DriverCursors`): regex/string matchers over message and commit text, numeric anomaly checks over phase durations and diff sizes, and direct-mention detection. A trigger is emitted when any rule fires; if no rule fires and the heartbeat is due, the driver picks `stale_window` (when no new evidence exists since the last inspection) or `heartbeat` (when there is new evidence that simply didn't trip a rule).

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
  roomMessages: LmWindowResponse['recentRoomMessages'];
  boardMessages: LmWindowResponse['recentBoardMessages'];
  cfg: MatcherConfig;
}): Array<{
  matcherKey: string;
  source: 'room' | 'board';
  messageId: number;
}>;
// Matcher hits and anomaly hits are triggers, not pre-judged findings.
// They cause an audit to run; the LM (Phase 7) assigns severity based on the
// full window context, including corroborating evidence.

// container/watchdog/src/anomalies.ts
interface AnomalyHit { anomalyKey: string; detail: string }
function findAnomalies(window: LmWindowResponse): AnomalyHit[];
// Initial rule set:
//   - phase_too_fast: a task transitioned to 'completed' in < 60s of wall-clock
//     time since 'in_progress'.
//   - test_failure_count_increased: most recent test build for an agent has more
//     failures than its previous test build on the same branch. Fires the trigger
//     unconditionally; the audit decides whether the increase is legitimate (e.g.
//     TDD red-phase, where the agent has just committed a deliberately failing
//     test) or a regression the agent is rationalising as out-of-scope.
//   - diff_size_outlier: most recent commit on an agent branch touched > 50
//     files OR > 2000 added lines.
// Thresholds live alongside the matcher config in /opt/watchdog/anomalies.json.

// container/watchdog/src/mentions.ts
function findMentions(args: {
  roomMessages: LmWindowResponse['recentRoomMessages'];
  boardMessages: LmWindowResponse['recentBoardMessages'];
  watchdogHandle: string;
}): Array<{ source: 'room' | 'board'; messageId: number }>;
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

**Worked example — `test_failure_count_increased` direction and corroboration.** The arithmetic gate is sign-sensitive; the *interpretation* of a hit is corroboration-sensitive. Concrete trace:

- Agent `agent-1` built at T+0 with 3 test failures.
- Agent `agent-1` built at T+1 with 5 test failures.
- `5 > 3`, the count increased on the same branch — **fire the trigger**. The trigger says "an audit is warranted", not "this is a regression".
- Sign-sensitivity: the comparison is `now.failures > prev.failures` on the **same branch**, **most recent two builds**. Inverted form (`prev > now`) would fire only when the suite improves — silencing the signal entirely. Builds on different branches do not compare. A build with `success=true` has `failures=0`.
- The audit window includes commits between T+0 and T+1 plus messages in the same window. The LM (Phase 7) decides the outcome from the bundle:
  - Commit message says "add failing tests for happy-path login (TDD red phase)" and the new failing tests are in the file the commit touched → **quiet**, this is normal red-phase work.
  - No agent commits in the window AND a container restart is visible in the activity log → ambiguous — earlier phase failures may have been left behind, or the restart itself caused them; the LM emits a `note` so the operator can confirm whether the failures belong to the agent's prior incarnation.
  - Commits touch unrelated files AND a message in the window contains rationalisation language matched by `pre_existing_failure` / `out_of_scope_errors` / `scoped_to_previous_phase` → **pause**, the agent is plausibly disclaiming failures their own work caused.

**Verification:**

- Unit tests in [`container/watchdog/src/matchers.test.ts`](../container/watchdog/src/matchers.test.ts), [`container/watchdog/src/anomalies.test.ts`](../container/watchdog/src/anomalies.test.ts), [`container/watchdog/src/mentions.test.ts`](../container/watchdog/src/mentions.test.ts).
- The matcher test asserts each seeded phrase fires on a positive sample and does not fire on a hand-crafted near-miss (e.g. `scoped_to_previous_phase` does not fire on "this is scoped to the current phase").
- The anomaly test asserts `test_failure_count_increased` fires for `(prev=3, now=5)` and does not fire for `(prev=5, now=3)` or `(prev=3, now=3)`.

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
  // branchHeads[agentName] is the most recent commit SHA observed on
  // docker/{projectId}/{agentName} after the driver fetched the bare repo.
  recentDiffs: Array<{
    agentName: string; sinceSha: string; nowSha: string;
    filesChanged: number; insertions: number; deletions: number;
    truncatedDiffText: string; // first 4000 chars of `git diff sinceSha..nowSha`
  }>;
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
  1. `git -C /workspace/repo fetch /repo.git '+refs/heads/docker/${PROJECT_ID}/*:refs/heads/docker/${PROJECT_ID}/*'` to refresh known agent branches.
  2. For each agent in `window.agents`, capture the head SHA and produce a diff against the project's seed branch `docker/${PROJECT_ID}/current-root`, capped at 4000 characters.
  3. Sample messages: include the **tail** of `recentRoomMessages` (the last 5) plus a uniform random sample of up to 15 more from the remainder, and the **full** `recentBoardMessages` list (capped at 50 — board volume is much lower than room volume, so the LM gets full visibility into agent debriefs and prior findings).
  4. Build the prompt using the watchdog agent definition (Phase 7) plus the JSON-serialised bundle.
- Invocation: spawn `claude -p` as a child process with stdin = prompt and `--output-format json` so token counts are recoverable. Honour `CLAUDE_CREDENTIALS_PATH` from the existing mount.
- The audit response is a JSON envelope (defined in Phase 7) the driver parses to produce `AuditResult`.
- On heartbeat with `outcome='quiet'`: post a one-line entry to the message board on `WATCHDOG_DEFAULT_CHANNEL` via `POST /messages` with `type='lm_heartbeat'` and payload `{text: 'LM heartbeat — quiet, no findings'}`. On any other trigger with `outcome='quiet'`: record the inspection but post nothing. `stale_window` cannot produce `quiet` — if the LM's response says it did, treat as an `error` outcome.
- On `outcome='finding'`: call `POST /lm/findings`. The server inserts the message-board row and updates the inspection's `produced_message_id` in the same handler (Phase 2).
- On `outcome='budget_exhausted'`: post a one-line entry once per UTC day on `WATCHDOG_DEFAULT_CHANNEL` with `type='lm_budget_exhausted'`, then short-circuit subsequent audits to a no-op until the day rolls over.

**Verification:**

- Tests in [`container/watchdog/src/audit.test.ts`](../container/watchdog/src/audit.test.ts) using a fake `claude -p` (a stub binary on `PATH`) that returns canned JSON envelopes for `quiet`, `finding`, and `error` cases.
- Coverage: heartbeat-quiet posts one message-board entry on the default channel with `type='lm_heartbeat'`; non-heartbeat-quiet posts nothing; `outcome='finding'` posts one entry with `type='lm_finding'` and the inspection's `produced_message_id` updates to the new row's ID; budget exhaustion posts once per UTC day with `type='lm_budget_exhausted'`; malformed audit JSON yields `outcome='error'` and an inspection row with `outcome='error'`; a `stale_window` trigger returning `quiet` is treated as `error`.

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
    "body": "<2-6 sentences; cites concrete agent names, branches, and message references in the form 'room#<id>' or 'board#<id>' so the operator can navigate to the originating message>",
    "notifyOperator": true | false
  } | null,
  "rationale": "<one paragraph; the LM's reasoning, kept for the inspection log>"
}
```

**Work:**

- Author [`dynamic-agents/lm-watchdog.md`](../dynamic-agents/lm-watchdog.md) covering: read-only role; the LM never pushes code or invokes tools that mutate repo state; quiet-discipline output (single line for "all quiet"); how to weight the bundle (recent test failure deltas dominate; matcher hits are pre-flagged for second-guessing, not blind acceptance; phase-too-fast anomalies require corroboration in commit content before promoting to a finding); when to choose `severity='pause'` vs `'note'` (pause only for safety/correctness regressions that would compound across subsequent phases AND that the agent is plausibly responsible for — agent commits in the window touching the failing test's subject, deletion or `.skip` of test files, agent commits touching files outside the task's declared scope, or rationalisation language attached to failures the agent's own commits could have caused; a test-failure increase without that corroboration is `note` at most, and a TDD red-phase commit that adds deliberately-failing tests is `quiet`; after a container restart, treat phase-boundary attribution claims with extra scepticism); how to handle `stale_window` triggers (an active project with no new commits, builds, or messages for 30 minutes is itself a finding — the LM emits `severity='note'` minimum citing the silent agents, and `severity='pause'` if any pump agent is in a non-idle status while producing no activity, since that points at a stuck or hung container; never return `quiet` on a `stale_window` trigger); how to use `recentBoardLmFindings` (the LM's memory of what it has flagged earlier in this run — restate the same finding only when conditions have *worsened* warranting escalation; if a previously-flagged condition has resolved, emit a `severity='note'` "previously flagged X has resolved" finding instead; if conditions are unchanged, return `quiet`); when to set `notifyOperator=true` (every `severity='pause'` finding sets it, since the operator should know when work is paused; `severity='note'` findings set it when the LM judges the operator should look without delay).
- The agent definition lists only the tools needed: `Read`, `Grep`, `Bash` (for `git log` / `git diff` inspection inside the watchdog's read-only worktree). No `Edit`, no `Write`, no network.
- The output contract is restated verbatim at the end of the agent file. The driver parses the last fenced JSON block in the response.
- Verify [`scripts/lib/compile-agents.sh`](../scripts/lib/compile-agents.sh) compiles the new file into `agents/lm-watchdog.md` without manual intervention. Per the compilation memory, do not run the compile script by hand — exercise it via the existing automated path (test or launch).

**Verification:**

- New entry exists in `agents/` after compilation runs.
- A hand-run audit (driven by Phase 10's smoke test) returns a valid JSON envelope; the driver's parser accepts it without error.

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
  messageId: integer('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
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
  5. Otherwise call `sendOperatorEmail`. On HTTP success → `reason='sent'`, `ok=true`. On HTTP error → `reason='error'`, `ok=false`, `errorBody` set. Either way insert one `lm_email_log` row referencing the just-posted `messages.id`.
- Subject line: `[LM ${projectId}] ${title}`. Body is plain text containing: project ID, finding title, finding body, severity, inspection ID, message-board channel, message-board entry ID, and a link to the message-board entry in the dashboard (if a dashboard URL is configured in project config — otherwise omit the link).
- The Resend wrapper performs no retries. A failed send lands in `lm_email_log` with `ok=false`; the operator inspects the log to triage. The route returns `emailed=false, emailReason='error'` to the watchdog so the inspection record correctly captures the attempt.
- Every email decision (skip or send, success or failure) lands in `lm_email_log` so the operator has a complete audit trail of what the LM tried to send and why.

**Worked example — cooldown direction.** The cooldown gate is sign-sensitive: cooldown is "time *since* last successful send", not "time *until* next allowed send". Concrete trace with `RESEND_COOLDOWN_MINUTES=15`:

- T+0:00: finding F1, `notifyOperator=true`. No prior `lm_email_log` for the project. `now − lastSentAt` is undefined → treated as ≥ 15 min. Send. New row `(messageId=M1, sentAt=T+0:00, ok=true, reason='sent')`.
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

## Phase 10 — End-to-end smoke test

**Outcome:** The operator can launch a watchdog against a real project, observe one heartbeat audit producing an "all quiet" message, plant a synthetic matcher phrase in a chat room and observe a tripwire-driven audit producing a finding, observe an email landing for a `notifyOperator=true` finding, and observe the watchdog self-shutting-down after the project goes idle. Confirm every inspection is recorded in `lm_inspections`.

**Types / APIs:** None — this phase is the operator-run verification of the integrated system.

**Work:**

Document the smoke test in [`container/watchdog/SMOKE.md`](../container/watchdog/SMOKE.md):

1. **Preconditions.** Coordination server running on `${SERVER_PORT}`. A pump container has been launched at least once for the chosen project so `docker/${PROJECT_ID}/current-root` exists, and at least one task is pending or in-flight (so `/coalesce/status` returns `canCoalesce: false` while the test runs). `WATCHDOG_HEARTBEAT_SECONDS=120`, `WATCHDOG_IDLE_SHUTDOWN_SECONDS=120`, `WATCHDOG_STALE_WINDOW_SECONDS=120` (all lowered for the test) in the operator's `.env`.
2. **Boot watchdog.** `./launch.sh --watchdog --project <id>`. Verify with `docker ps` that the `lm-watchdog` service is up. Tail container logs.
3. **First heartbeat.** Within `WATCHDOG_HEARTBEAT_SECONDS + WATCHDOG_POLL_SECONDS` of boot, query `GET /messages/${WATCHDOG_DEFAULT_CHANNEL}` and observe a single entry with `type='lm_heartbeat'`, `fromAgent` matching `WATCHDOG_AGENT_IDENTITY`, and payload text "LM heartbeat — quiet, no findings". Confirm one row in `lm_inspections` with `triggerKind='heartbeat'`, `outcome='quiet'`, and `produced_message_id` matching the entry's ID.
4. **Plant a tripwire.** Operator posts a message in a chat room (an existing `/rooms/*` room the agents use, *not* the message-board channel) reading "Test failures here are pre-existing — already broken before this phase." This contains both `pre_existing_failure` and `already_broken` matcher phrases. The watchdog reads room messages as part of its window scan, so the matcher fires from there.
5. **Tripwire audit.** Within `WATCHDOG_POLL_SECONDS` of the planted message, query `GET /messages/${WATCHDOG_DEFAULT_CHANNEL}` and observe a second entry with `type='lm_finding'` referring to the planted text. Confirm a second `lm_inspections` row with `triggerKind='matcher'`, `outcome='finding'`, and `produced_message_id` matching the new entry.
6. **Cursor advances.** Operator posts the *same* matcher message a second time in the same room. Within `WATCHDOG_POLL_SECONDS`, confirm a new inspection only fires for the *new* message (cursor advanced past step 4's message ID; step 4's message will not re-trigger). The new message's matcher hit may or may not produce a finding depending on the LM's behavioural judgment about restating versus escalating — both outcomes are acceptable; the test asserts the cursor model, not the LM's choice.
7. **Email path.** With `RESEND_API_KEY` and `RESEND_FROM` set in the server's host environment and `operator_email` set on the project, hand-call `POST /lm/findings` from the dashboard with `notifyOperator: true` and `severity: 'pause'`. Confirm the operator receives an email; confirm one `lm_email_log` row with `reason='sent', ok=true` referencing the new `messages.id`; confirm `POST /coalesce/pause` was called (pump agents now `paused`).
8. **Email cooldown.** Within `RESEND_COOLDOWN_MINUTES`, hand-call `POST /lm/findings` again with `notifyOperator: true`. Confirm a second `lm_email_log` row with `reason='cooldown', ok=false` and **no** new email landed.
9. **Heartbeat clock reset.** Confirm that the next heartbeat fires `WATCHDOG_HEARTBEAT_SECONDS` after the most recent inspection (whichever from steps 5–8 was latest), not after step 3's.
10. **Idle shutdown.** Operator marks the test pump's pending task as `completed` and confirms `/coalesce/status` returns `canCoalesce: true`. Within `WATCHDOG_IDLE_SHUTDOWN_SECONDS + WATCHDOG_POLL_SECONDS`, confirm: a final `lm_shutdown` entry on `${WATCHDOG_DEFAULT_CHANNEL}`, the container exits cleanly with code 0 (`docker ps -a` shows `Exited (0)`), and the container has *not* restarted (compose `restart: "no"` honoured).

**Verification:**

- Operator walks the smoke test top to bottom and observes each enumerated outcome.
- All `lm_inspections` rows from the run have `outcome ∈ {'quiet', 'finding'}`, none have `outcome='error'`.
- The container's exit code is 0 and the container is not in a restarting state.
- Operator-run rebuild of the watchdog image succeeds: `docker compose -f container/docker-compose.yml build lm-watchdog`.
