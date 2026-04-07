import type { TaskDbRow } from '../queries/tasks-core.js';

export interface TaskRow {
  id: number;
  project_id: string;
  title: string;
  description: string;
  source_path: string | null;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  result: unknown;
  base_priority: number;
  progress_log: string | null;
  created_at: string;
  // Drizzle (camelCase) variants
  projectId?: string;
  sourcePath?: string | null;
  acceptanceCriteria?: string | null;
  claimedBy?: string | null;
  claimedAt?: string | Date | null;
  completedAt?: string | Date | null;
  basePriority?: number;
  progressLog?: string | null;
  createdAt?: string | Date | null;
}

/** Convert a Drizzle TaskDbRow to the TaskRow shape used by formatTask. */
export function toTaskRow(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    description: row.description ?? '',
    source_path: row.sourcePath,
    acceptance_criteria: row.acceptanceCriteria,
    status: row.status,
    priority: row.priority,
    claimed_by: row.claimedBy,
    claimed_at: row.claimedAt ? String(row.claimedAt) : null,
    completed_at: row.completedAt ? String(row.completedAt) : null,
    result: row.result ?? null, // jsonb column — Drizzle returns unknown; parseResult handles coercion
    base_priority: row.basePriority,
    progress_log: row.progressLog,
    created_at: row.createdAt ? String(row.createdAt) : '',
    // Also set camelCase variants for pick() compatibility
    projectId: row.projectId,
    sourcePath: row.sourcePath,
    acceptanceCriteria: row.acceptanceCriteria,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    basePriority: row.basePriority,
    progressLog: row.progressLog,
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

/** Pick the camelCase field if the key exists on the object, otherwise fall back to snake_case. */
function pick<T>(row: Record<string, unknown>, camel: string, snake: string): T {
  if (camel in row) return row[camel] as T;
  return row[snake] as T;
}

export function formatTask(row: TaskRow, files?: string[], dependsOn?: number[], blockedBy?: number[], blockReasons?: string[]) {
  const r = row as unknown as Record<string, unknown>;
  const result = parseResult(pick(r, 'result', 'result'));
  const completedBy = (() => {
    if (!result || typeof result !== 'object') return null;
    return (result as Record<string, unknown>).agent as string ?? null;
  })();

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: pick<string | null>(r, 'sourcePath', 'source_path'),
    acceptanceCriteria: pick<string | null>(r, 'acceptanceCriteria', 'acceptance_criteria'),
    status: row.status,
    priority: row.priority,
    files: files ?? [],
    dependsOn: dependsOn ?? [],
    blockedBy: blockedBy ?? [],
    blockReasons: blockReasons ?? [],
    claimedBy: pick<string | null>(r, 'claimedBy', 'claimed_by'),
    claimedAt: pick<string | Date | null>(r, 'claimedAt', 'claimed_at'),
    completedAt: pick<string | Date | null>(r, 'completedAt', 'completed_at'),
    result,
    completedBy,
    progressLog: pick<string | null>(r, 'progressLog', 'progress_log'),
    createdAt: pick<string | Date | null>(r, 'createdAt', 'created_at'),
    projectId: pick<string>(r, 'projectId', 'project_id'),
  };
}
