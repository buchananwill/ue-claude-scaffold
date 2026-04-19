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
    agentTypeOverride: row.agentTypeOverride ?? null,
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
    createdAt: row.createdAt,
    projectId: row.projectId,
  };
}
