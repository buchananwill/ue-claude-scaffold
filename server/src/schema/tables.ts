import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
  foreignKey,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// 1. agents
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    worktree: text("worktree").notNull(),
    planDoc: text("plan_doc"),
    // Valid values: idle | working | done | error | paused | stopping | deleted
    status: text("status").notNull().default("idle"),
    mode: text("mode").notNull().default("single"),
    registeredAt: timestamp("registered_at").defaultNow(),
    containerHost: text("container_host"),
    sessionToken: text("session_token").unique(),
  },
  (table) => [
    unique("agents_project_name_unique").on(table.projectId, table.name),
  ],
);

// 2. ubtLock — host-level singleton mutex (one lock per UBT host)
export const ubtLock = pgTable("ubt_lock", {
  hostId: text("host_id").primaryKey().default("local"),
  holderAgentId: uuid("holder_agent_id").references(() => agents.id, {
    onDelete: "restrict",
  }),
  acquiredAt: timestamp("acquired_at"),
  priority: integer("priority").default(0),
});

// 3. ubtQueue — global FIFO with priority (all agents, all projects)
export const ubtQueue = pgTable("ubt_queue", {
  id: serial("id").primaryKey(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "restrict" }),
  priority: integer("priority").default(0),
  requestedAt: timestamp("requested_at").defaultNow(),
});

// 4. buildHistory
export const buildHistory = pgTable(
  "build_history",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agent: text("agent").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    type: text("type").notNull(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    durationMs: integer("duration_ms"),
    success: integer("success"),
    output: text("output"),
    stderr: text("stderr"),
  },
  (table) => [
    check("build_history_type_check", sql`${table.type} IN ('build', 'test')`),
  ],
);

// 5. messages
export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    fromAgent: text("from_agent").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    channel: text("channel").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at"),
    resolvedAt: timestamp("resolved_at"),
    result: jsonb("result"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_messages_channel").on(table.channel),
    index("idx_messages_channel_id").on(table.channel, table.id),
    index("idx_messages_claimed").on(table.claimedBy),
  ],
);

// 6. tasks — born-fresh under the durable-task-FSM schema fork.
//    Pre-cutover rows live in tasks_pre_fsm_archive (created in Phase 9) and never
//    transit into this table. New FSM columns: review cycle accounting, build status,
//    arbitration handshake fields, structured failure metadata, and per-task agent-role
//    overrides. The legacy 'cycle' status remains in the enum because the dependency-
//    graph code path needs it for circular-dependency signalling — it is orthogonal to
//    the new FSM and new-FSM tasks never enter it.
export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    description: text("description").default(""),
    sourcePath: text("source_path"),
    acceptanceCriteria: text("acceptance_criteria"),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    basePriority: integer("base_priority").notNull().default(0),
    claimedByAgentId: uuid("claimed_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    claimedAt: timestamp("claimed_at"),
    completedAt: timestamp("completed_at"),
    result: jsonb("result"),
    progressLog: text("progress_log"),
    // FSM: review cycle accounting
    reviewCycleCount: integer("review_cycle_count").notNull().default(0),
    reviewCycleBudget: integer("review_cycle_budget").notNull().default(5),
    reviewerVerdicts: jsonb("reviewer_verdicts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    latestReviewPath: text("latest_review_path"),
    // FSM: build state tracked separately from task status
    buildStatus: text("build_status").notNull().default("pending"),
    commitSha: text("commit_sha"),
    // FSM: arbitration handshake — set on entry to 'arbitrating', cleared on exit
    arbitrationPendingTrigger: text("arbitration_pending_trigger"),
    // FSM: arbitrator's ruling addendum, surfaced to the engineer's revising-cycle prompt
    arbitrationAddendumPath: text("arbitration_addendum_path"),
    // FSM: structured failure metadata, populated only on entry to 'failed'
    failureReason: text("failure_reason"),
    failureDetail: text("failure_detail"),
    // FSM: per-task override of the project default agent-role wiring (project default lives in scaffold.config.json)
    agentRolesOverride: jsonb("agent_roles_override"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    check(
      "tasks_status_check",
      sql`${table.status} IN ('pending','claimed','engineering','built','reviewing','revising','arbitrating','completed','failed','integrated','cycle')`,
    ),
    check(
      "tasks_build_status_check",
      sql`${table.buildStatus} IN ('pending','clean','dirty','failed')`,
    ),
    check(
      "tasks_failure_reason_check",
      sql`${table.failureReason} IS NULL OR ${table.failureReason} IN (
      'review_cycle_budget_exhausted',
      'reviewer_contradiction',
      'engineer_build_failure',
      'reviewer_infrastructure_failure',
      'role_session_no_op',
      'arbitrator_escalated'
    )`,
    ),
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_priority").on(table.priority.desc(), table.id.asc()),
  ],
);

// 7. files
export const files = pgTable(
  "files",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    path: text("path").notNull(),
    claimantAgentId: uuid("claimant_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    claimedAt: timestamp("claimed_at"),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.path] })],
);

// 8. taskFiles
export const taskFiles = pgTable(
  "task_files",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.filePath] }),
    index("idx_task_files_path").on(table.filePath),
  ],
);

// 9. taskDependencies
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOn: integer("depends_on")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOn] }),
    check("task_deps_no_self", sql`${table.taskId} != ${table.dependsOn}`),
    index("idx_task_deps_task").on(table.taskId),
    index("idx_task_deps_dep").on(table.dependsOn),
  ],
);

// 10. rooms
export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    type: text("type").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    check("rooms_type_check", sql`${table.type} IN ('group','direct')`),
  ],
);

// 11. roomMembers
export const roomMembers = pgTable(
  "room_members",
  {
    id: uuid("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at").defaultNow(),
  },
  (table) => [
    unique("room_members_room_agent_unique").on(table.roomId, table.agentId),
  ],
);

// 12. chatMessages
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    content: text("content").notNull(),
    replyTo: integer("reply_to"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_chat_room_id").on(table.roomId, table.id),
    foreignKey({
      columns: [table.replyTo],
      foreignColumns: [table.id],
    }).onDelete("set null"),
  ],
);

// 13. teams
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    briefPath: text("brief_path"),
    status: text("status").notNull().default("active"),
    deliverable: text("deliverable"),
    createdAt: timestamp("created_at").defaultNow(),
    dissolvedAt: timestamp("dissolved_at"),
  },
  (table) => [
    check(
      "teams_status_check",
      sql`${table.status} IN ('active','converging','dissolved')`,
    ),
  ],
);

// 14. projects — portable project configuration (no filesystem paths)
//
// FSM role wiring (engineer / arbitrator / reviewers) does not live here: agent
// definitions are operator-local markdown on disk where the server runs, so the
// role-→-agent mapping is operator-local config rather than portable project
// state. The authoritative source is scaffold.config.json, colocated with the
// agent definition markdown in the repo.
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    engineVersion: text("engine_version"),
    seedBranch: text("seed_branch"),
    buildTimeoutMs: integer("build_timeout_ms"),
    testTimeoutMs: integer("test_timeout_ms"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    check("projects_id_check", sql`${table.id} ~ '^[a-zA-Z0-9_-]{1,64}$'`),
  ],
);

// 15. teamMembers
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    isLeader: boolean("is_leader").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.agentId] }),
    uniqueIndex("idx_team_leader")
      .on(table.teamId)
      .where(sql`is_leader = true`),
  ],
);

// 16. claudeCodeContainerSessions — records every `claude -p` invocation in a container
export const claudeCodeContainerSessions = pgTable(
  "claude_code_container_sessions",
  {
    id: uuid("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    taskId: integer("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
    exitCode: integer("exit_code"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    rawOutput: jsonb("raw_output"),
  },
  (table) => [
    check(
      "ccs_status_check",
      sql`${table.status} IN ('running','complete','aborted','stopped')`,
    ),
    index("idx_ccs_project").on(table.projectId),
    index("idx_ccs_agent").on(table.agentId),
    index("idx_ccs_task").on(table.taskId),
    index("idx_ccs_project_started").on(
      table.projectId,
      table.startedAt.desc(),
    ),
  ],
);

// 17. reviewRuns — one row per (task, cycle, reviewerRole) for completed reviewer runs.
//     Reviewer-session crashes are infrastructure events tracked via
//     claude_code_container_sessions.exitCode and never produce a row here. Absence of
//     a row for a (taskId, cycle, reviewerRole) triple means "did not complete," not
//     "rejected the code."
export const reviewRuns = pgTable(
  "review_runs",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    cycle: integer("cycle").notNull(),
    reviewerRole: text("reviewer_role").notNull(),
    verdict: text("verdict").notNull(),
    rawMarkdown: text("raw_markdown").notNull(),
    postedAt: timestamp("posted_at").notNull().defaultNow(),
  },
  (table) => [
    unique("review_runs_task_cycle_role_unique").on(
      table.taskId,
      table.cycle,
      table.reviewerRole,
    ),
    check(
      "reviewer_runs_verdict_check",
      sql`${table.verdict} IN ('approve','request_changes','out_of_scope')`,
    ),
    index("idx_review_runs_task_cycle").on(table.taskId, table.cycle),
  ],
);

// 18. arbitrationRuns — at most one ruling per (task, trigger). Records the
//     arbitrator's verdict on either a cycle-budget exhaustion or a reviewer
//     contradiction. When ruling = 'rule', contradictionResolution names the upheld
//     and retired findings; otherwise it is null.
export const arbitrationRuns = pgTable(
  "arbitration_runs",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    ruling: text("ruling").notNull(),
    rulingMarkdown: text("ruling_markdown").notNull(),
    contradictionResolution: jsonb("contradiction_resolution"),
    postedAt: timestamp("posted_at").notNull().defaultNow(),
  },
  (table) => [
    unique("arbitration_runs_task_trigger_unique").on(
      table.taskId,
      table.trigger,
    ),
    check(
      "arbitration_runs_trigger_check",
      sql`${table.trigger} IN ('review_cycle_budget_exhausted','reviewer_contradiction')`,
    ),
    check(
      "arbitration_runs_ruling_check",
      sql`${table.ruling} IN ('approve','rule','escalate')`,
    ),
    check(
      "arbitration_runs_rule_resolution_check",
      sql`(${table.ruling} = 'rule' AND ${table.contradictionResolution} IS NOT NULL)
        OR (${table.ruling} <> 'rule' AND ${table.contradictionResolution} IS NULL)`,
    ),
    index("idx_arbitration_runs_task").on(table.taskId),
  ],
);

// 19. reviewFindings — per-finding child rows of review_runs.
//     Severity is two-tier: BLOCKING means the engineer must address before the cycle
//     can transition to 'completed'; NOTE is observability-only and never acted on by
//     the engineer (it lands here so the operator can aggregate signals across tasks).
//     The legacy WARNING tier is removed.
export const reviewFindings = pgTable(
  "review_findings",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    severity: text("severity").notNull(),
    ordinal: integer("ordinal").notNull(),
    filePath: text("file_path"),
    line: integer("line"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    evidence: text("evidence"),
    fix: text("fix"),
  },
  (table) => [
    check(
      "review_findings_severity_check",
      sql`${table.severity} IN ('BLOCKING','NOTE')`,
    ),
    index("idx_review_findings_run").on(table.runId),
    index("idx_review_findings_task_severity").on(table.severity),
  ],
);
