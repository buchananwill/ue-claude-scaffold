import type { TaskDbRow } from '../queries/tasks-core.js';

export interface TaskRow {
  id: number;
  projectId: string;
  title: string;
  description: string;
  sourcePath: string | null;
  acceptanceCriteria: string | null;
  status: string;
  priority: number;
  claimedBy: string | null;
  claimedAt: string | Date | null;
  completedAt: string | Date | null;
  result: unknown;
  basePriority: number;
  progressLog: string | null;
  agentTypeOverride: string | null;
  /**
   * Per-task FSM agent-role wiring override. jsonb in the schema; the route
   * layer ships it to the container so pump-loop.sh's _resolve_roles_for_task
   * can shallow-merge it over the project default. `null` means "use the
   * project default wholesale".
   */
  agentRolesOverride: unknown;
  // FSM read-side fields surfaced for role-session prompt builders. Writes go
  // through POST /tasks/:id/transition; these are read-only on the API.
  reviewCycleCount: number;
  reviewCycleBudget: number;
  /**
   * Per-reviewer verdict map keyed by reviewer-role slug. jsonb in the
   * schema; the dashboard renders these as cycle verdict chips. `{}` is the
   * cleared state set on entry to `reviewing`.
   */
  reviewerVerdicts: unknown;
  latestReviewPath: string | null;
  arbitrationPendingTrigger: string | null;
  arbitrationAddendumPath: string | null;
  failureReason: string | null;
  failureDetail: string | null;
  buildStatus: string;
  commitSha: string | null;
  createdAt: string | Date | null;
}

/** Convert a Drizzle TaskDbRow to the TaskRow shape used by formatTask. */
export function toTaskRow(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description ?? '',
    sourcePath: row.sourcePath,
    acceptanceCriteria: row.acceptanceCriteria,
    status: row.status,
    priority: row.priority,
    // API-compat: external consumers see "claimedBy"; internal column is claimedByAgentId
    claimedBy: row.claimedByAgentId,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    result: row.result ?? null, // jsonb column — Drizzle returns unknown; parseResult handles coercion
    basePriority: row.basePriority,
    progressLog: row.progressLog,
    agentTypeOverride: row.agentTypeOverride,
    agentRolesOverride: row.agentRolesOverride ?? null,
    reviewCycleCount: row.reviewCycleCount ?? 0,
    reviewCycleBudget: row.reviewCycleBudget ?? 5,
    reviewerVerdicts: row.reviewerVerdicts ?? {},
    latestReviewPath: row.latestReviewPath ?? null,
    arbitrationPendingTrigger: row.arbitrationPendingTrigger ?? null,
    arbitrationAddendumPath: row.arbitrationAddendumPath ?? null,
    failureReason: row.failureReason ?? null,
    failureDetail: row.failureDetail ?? null,
    buildStatus: row.buildStatus ?? 'pending',
    commitSha: row.commitSha ?? null,
    createdAt: row.createdAt,
  };
}

function parseResult(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw; // Drizzle returns jsonb as objects
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

export function formatTask(row: TaskRow, files?: string[], dependsOn?: number[], blockedBy?: number[], blockReasons?: string[]) {
  const result = parseResult(row.result);
  const completedBy = (() => {
    if (!result || typeof result !== 'object') return null;
    return (result as Record<string, unknown>).agent as string ?? null;
  })();

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.sourcePath,
    acceptanceCriteria: row.acceptanceCriteria,
    status: row.status,
    priority: row.priority,
    files: files ?? [],
    dependsOn: dependsOn ?? [],
    blockedBy: blockedBy ?? [],
    blockReasons: blockReasons ?? [],
    // API-compat: external consumers see "claimedBy"; internal column is claimedByAgentId
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    result,
    completedBy,
    progressLog: row.progressLog,
    agentTypeOverride: row.agentTypeOverride,
    agentRolesOverride: row.agentRolesOverride ?? null,
    reviewCycleCount: row.reviewCycleCount,
    reviewCycleBudget: row.reviewCycleBudget,
    reviewerVerdicts: row.reviewerVerdicts ?? {},
    latestReviewPath: row.latestReviewPath,
    arbitrationPendingTrigger: row.arbitrationPendingTrigger,
    arbitrationAddendumPath: row.arbitrationAddendumPath,
    failureReason: row.failureReason,
    failureDetail: row.failureDetail,
    buildStatus: row.buildStatus,
    commitSha: row.commitSha,
    createdAt: row.createdAt,
    projectId: row.projectId,
  };
}
