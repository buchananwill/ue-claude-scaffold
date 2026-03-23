export interface TaskRow {
  id: number;
  title: string;
  description: string;
  source_path: string | null;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  result: string | null;
  base_priority: number;
  progress_log: string | null;
  created_at: string;
}

export function formatTask(row: TaskRow, files?: string[], dependsOn?: number[], blockedBy?: number[], blockReasons?: string[]) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.source_path,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    priority: row.priority,
    files: files ?? [],
    dependsOn: dependsOn ?? [],
    blockedBy: blockedBy ?? [],
    blockReasons: blockReasons ?? [],
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    result: row.result ? JSON.parse(row.result) : null,
    completedBy: (() => {
      if (!row.result) return null;
      try { return JSON.parse(row.result)?.agent ?? null; } catch { return null; }
    })(),
    progressLog: row.progress_log,
    createdAt: row.created_at,
  };
}
