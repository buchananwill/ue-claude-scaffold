export interface Project {
  id: string;
  name: string;
  engineVersion: string | null;
  seedBranch: string | null;
  buildTimeoutMs: number | null;
  testTimeoutMs: number | null;
  createdAt: string;
}

export interface HealthResponse {
  status: string;
  dbPath: string;
  config: {
    port: number;
    projectName: string;
    ubtLockTimeoutMs: number;
  };
}

export interface Agent {
  id: string;
  name: string;
  worktree: string;
  planDoc: string | null;
  status: string;
  registeredAt: string;
}

/**
 * Per-project agent-role wiring. Shape mirrors the `projects.agent_roles`
 * jsonb column declared in server/src/schema/tables.ts.
 */
export interface AgentRoles {
  engineer: string;
  arbitrator: string;
  reviewers: Record<string, string>;
}

/** Per-reviewer verdict tracked on tasks.reviewer_verdicts jsonb. */
export type ReviewerVerdict = 'pending' | 'approve' | 'request_changes' | 'out_of_scope';

/** Map keyed by reviewer-role slug (e.g. 'safety', 'correctness'). */
export type ReviewerVerdictMap = Partial<Record<string, ReviewerVerdict>>;

/** Tuple of all valid `tasks.failure_reason` values for the failed status. */
export const FAILURE_REASONS = [
  'review_cycle_budget_exhausted',
  'reviewer_contradiction',
  'engineer_build_failure',
  'reviewer_infrastructure_failure',
  'role_session_no_op',
  'arbitrator_escalated',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface Task {
  id: number;
  title: string;
  description: string;
  sourcePath: string | null;
  acceptanceCriteria: string | null;
  status: string;
  priority: number;
  files: string[];
  dependsOn: number[];
  blockedBy: number[];
  blockReasons: string[];
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  progressLog: string | null;
  agentTypeOverride: string | null;
  createdAt: string;
  // New FSM columns (Plan: Durable Task FSM and Parallel Role Sessions).
  reviewCycleCount: number;
  reviewCycleBudget: number;
  reviewerVerdicts: ReviewerVerdictMap;
  latestReviewPath: string | null;
  arbitrationPendingTrigger: string | null;
  arbitrationAddendumPath: string | null;
  failureReason: FailureReason | null;
  failureDetail: string | null;
  agentRolesOverride: AgentRoles | null;
  buildStatus: string;
  commitSha: string | null;
}

export interface TasksPage {
  tasks: Task[];
  total: number;
}

export interface Message {
  id: number;
  fromAgent: string;
  channel: string;
  type: string;
  payload: unknown;
  claimedBy: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  result: unknown;
  createdAt: string;
}

export interface SearchResults {
  tasks: Task[];
  messages: Message[];
  agents: Agent[];
}

export interface BuildRecord {
  id: number;
  agent: string;
  type: "build" | "test";
  startedAt: string;
  durationMs: number | null;
  success: boolean | null;
  output: string | null;
  stderr: string | null;
}

export interface UbtStatus {
  holder: string | null;
  acquiredAt: string | null;
  stale?: boolean;
  queue: UbtQueueEntry[];
  estimatedWaitMs: number;
}

export interface UbtQueueEntry {
  id: number;
  agent: string;
  priority: number;
  requestedAt: string;
}

export interface Room {
  id: string;
  name: string;
  type: "group" | "direct";
  createdBy: string;
  createdAt: string;
  memberCount: number;
}

export interface RoomMember {
  member: string;
  joinedAt: string;
}

export interface RoomDetail {
  id: string;
  name: string;
  type: "group" | "direct";
  createdBy: string;
  createdAt: string;
  members: RoomMember[];
}

export interface ChatMessage {
  id: number;
  roomId: string;
  sender: string;
  content: string;
  replyTo: number | null;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  briefPath: string | null;
  status: string;
  deliverable: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}

export interface TeamMember {
  agentName: string;
  role: string;
  isLeader: boolean;
}

export interface TeamDetail {
  id: string;
  name: string;
  briefPath: string | null;
  status: string;
  deliverable: string | null;
  createdAt: string;
  dissolvedAt: string | null;
  members: TeamMember[];
}

/**
 * Single finding row produced by a reviewer for a given review run.
 * Mirrors the `review_findings` table.
 */
export interface ReviewFinding {
  id: number;
  runId?: number;
  severity: 'BLOCKING' | 'NOTE';
  ordinal: number;
  filePath: string | null;
  line: number | null;
  title: string;
  description: string;
  evidence: string | null;
  fix: string | null;
}

/**
 * One reviewer's contribution to a single review cycle.
 * Mirrors a row of `review_runs` joined with its `review_findings` children.
 */
export interface ReviewRun {
  reviewerRole: string;
  verdict: ReviewerVerdict;
  rawMarkdown: string;
  postedAt: string;
  findings: ReviewFinding[];
}

/** Response shape for `GET /tasks/:id/reviews/:cycle`. */
export interface ReviewCycleResponse {
  cycle: number;
  runs: ReviewRun[];
}

/**
 * Arbitration ruling row from the `arbitration_runs` table.
 * `contradictionResolution` is non-null only when `ruling === 'rule'`.
 */
export interface ArbitrationRun {
  id: number;
  taskId: number;
  trigger: 'review_cycle_budget_exhausted' | 'reviewer_contradiction';
  ruling: 'approve' | 'rule' | 'escalate';
  rulingMarkdown: string;
  contradictionResolution: {
    upheldFindingId: number;
    retiredFindingId: number;
    rationale: string;
  } | null;
  postedAt: string;
}

/**
 * BLOCKING-list row shape returned by `GET /findings`. Trimmed compared
 * to `ReviewFinding` because the list view does not include
 * description/evidence/fix bodies.
 */
export interface Finding {
  id: number;
  taskId: number;
  cycle: number;
  reviewerRole: string;
  severity: 'BLOCKING' | 'NOTE';
  filePath: string | null;
  line: number | null;
  title: string;
  postedAt: string;
}

export interface FindingsResponse {
  findings: Finding[];
  total: number;
}

export interface NotePattern {
  title: string;
  count: number;
  exampleFindingIds: number[];
}

export interface NotePatternsResponse {
  patterns: NotePattern[];
}

export interface ArbitrationPattern {
  trigger: string;
  ruling: string;
  count: number;
  exampleTaskIds: number[];
}

export interface ArbitrationPatternsResponse {
  patterns: ArbitrationPattern[];
}

export interface FailureReasonPattern {
  failureReason: FailureReason;
  count: number;
  exampleTaskIds: number[];
}

export interface FailureReasonsResponse {
  patterns: FailureReasonPattern[];
}
