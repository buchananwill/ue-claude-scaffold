import type Database from 'better-sqlite3';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';
import { existsInBareRepo, isCommittedInRepo } from '../git-utils.js';
import { formatTask, type TaskRow } from './tasks-types.js';

export interface ConflictInfo {
  file: string;
  claimant: string;
}

export interface TasksOpts {
  config: ScaffoldConfig;
}

export interface TaskBody {
  title: string;
  description?: string;
  sourcePath?: string;
  sourceContent?: string;
  acceptanceCriteria?: string;
  priority?: number;
  files?: string[];
  targetAgents?: string[] | string;
  dependsOn?: number[];
  dependsOnIndex?: number[];
}

export const taskBodyKeys: { [K in keyof Required<TaskBody>]: true } = {
  title: true,
  description: true,
  sourcePath: true,
  sourceContent: true,
  acceptanceCriteria: true,
  priority: true,
  files: true,
  targetAgents: true,
  dependsOn: true,
  dependsOnIndex: true,
};

export type PatchBody = Omit<TaskBody, 'sourceContent' | 'targetAgents' | 'dependsOnIndex'>;
export const patchBodyKeys: { [K in keyof Required<PatchBody>]: true } = {
  title: true,
  description: true,
  sourcePath: true,
  acceptanceCriteria: true,
  priority: true,
  files: true,
  dependsOn: true,
};

export interface TasksSharedStatements {
  insertTask: Database.Statement;
  getTaskById: Database.Statement;
  claimTask: Database.Statement;
  updateProgress: Database.Statement;
  completeTask: Database.Statement;
  failTask: Database.Statement;
  releaseTask: Database.Statement;
  resetTask: Database.Statement;
  integrateTask: Database.Statement;
  integrateBatch: Database.Statement;
  integrateAll: Database.Statement;
  selectCompletedByAgent: Database.Statement;
  selectAllCompleted: Database.Statement;
  insertFile: Database.Statement;
  insertTaskFile: Database.Statement;
  getTaskFiles: Database.Statement;
  deleteTaskFiles: Database.Statement;
  insertDep: Database.Statement;
  getDepsForTask: Database.Statement;
  getIncompleteBlockersForTask: Database.Statement;
  getWrongBranchBlockersForTask: Database.Statement;
  deleteDepsForTask: Database.Statement;
  claimFilesForAgent: Database.Statement;
  getFileConflicts: Database.Statement;
  getFileConflictsForTask: Database.Statement;
  deleteTask: Database.Statement;
  hasValue: (v: string | null | undefined) => boolean;
  getValidationWorktree: () => string;
  getBareRepoPath: () => string;
  validateFilePaths: (files: string[]) => string | null;
  unknownFields: <T>(body: unknown, known: { [K in keyof T]: true }) => string[];
  linkFilesToTask: (taskId: number, files: string[]) => void;
  linkDepsToTask: (taskId: number, depIds: number[]) => void;
  filesForTask: (taskId: number) => string[];
  depsForTask: (taskId: number) => number[];
  blockersForTask: (taskId: number, agent: string) => number[];
  blockReasonsForTask: (row: TaskRow, agent: string) => string[];
  formatTaskWithFiles: (row: TaskRow, agent: string) => ReturnType<typeof formatTask>;
  checkAndClaimFiles: (taskId: number, agent: string) => ConflictInfo[] | null;
}

export function initTasksSharedStatements(config: ScaffoldConfig): TasksSharedStatements {
  const insertTask = db.prepare(
    `INSERT INTO tasks (title, description, source_path, acceptance_criteria, priority, base_priority)
     VALUES (@title, @description, @sourcePath, @acceptanceCriteria, @priority, @priority)`
  );

  const getTaskById = db.prepare('SELECT * FROM tasks WHERE id = @id');

  const claimTask = db.prepare(
    `UPDATE tasks SET status = 'claimed', claimed_by = @agent, claimed_at = CURRENT_TIMESTAMP
     WHERE id = @id AND status = 'pending'`
  );

  const updateProgress = db.prepare(
    `UPDATE tasks SET status = 'in_progress',
       progress_log = COALESCE(progress_log, '') || datetime('now') || ': ' || @progress || char(10)
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const completeTask = db.prepare(
    `UPDATE tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP, result = @result
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const failTask = db.prepare(
    `UPDATE tasks SET status = 'failed', completed_at = CURRENT_TIMESTAMP, result = @result
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const releaseTask = db.prepare(
    `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const resetTask = db.prepare(
    `UPDATE tasks
     SET status = 'pending',
         claimed_by = NULL,
         claimed_at = NULL,
         completed_at = NULL,
         result = NULL,
         progress_log = NULL
     WHERE id = @id AND status IN ('completed', 'failed', 'cycle')`
  );

  const integrateTask = db.prepare(
    `UPDATE tasks SET status = 'integrated' WHERE id = @id AND status = 'completed'`
  );

  const integrateBatch = db.prepare(
    `UPDATE tasks SET status = 'integrated' WHERE status = 'completed' AND json_extract(result, '$.agent') = ?`
  );

  const integrateAll = db.prepare(
    `UPDATE tasks SET status = 'integrated' WHERE status = 'completed'`
  );

  const selectCompletedByAgent = db.prepare(
    `SELECT id FROM tasks WHERE status = 'completed' AND json_extract(result, '$.agent') = ?`
  );

  const selectAllCompleted = db.prepare(
    `SELECT id FROM tasks WHERE status = 'completed'`
  );

  const insertFile = db.prepare('INSERT OR IGNORE INTO files (path) VALUES (?)');
  const insertTaskFile = db.prepare('INSERT INTO task_files (task_id, file_path) VALUES (?, ?)');
  const getTaskFiles = db.prepare('SELECT file_path FROM task_files WHERE task_id = ?');
  const deleteTaskFiles = db.prepare('DELETE FROM task_files WHERE task_id = ?');

  const insertDep = db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)');
  const getDepsForTask = db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?');
  const getIncompleteBlockersForTask = db.prepare(`
    SELECT d.depends_on FROM task_dependencies d
    JOIN tasks dep ON dep.id = d.depends_on
    WHERE d.task_id = ?
      AND dep.status NOT IN ('completed', 'integrated')
  `);
  const getWrongBranchBlockersForTask = db.prepare(`
    SELECT d.depends_on FROM task_dependencies d
    JOIN tasks dep ON dep.id = d.depends_on
    WHERE d.task_id = ?
      AND dep.status = 'completed'
      AND (json_extract(dep.result, '$.agent') IS NULL
           OR json_extract(dep.result, '$.agent') != ?)
  `);
  const deleteDepsForTask = db.prepare('DELETE FROM task_dependencies WHERE task_id = ?');

  const claimFilesForAgent = db.prepare(
    `UPDATE files SET claimant = ?, claimed_at = CURRENT_TIMESTAMP
     WHERE path = ? AND claimant IS NULL`
  );

  const getFileConflicts = db.prepare(
    `SELECT f.path, f.claimant FROM task_files tf
     JOIN files f ON f.path = tf.file_path
     WHERE tf.task_id = ? AND f.claimant IS NOT NULL AND f.claimant != ?`
  );

  // NOTE: This query returns ALL file locks, not filtered by requesting agent.
  // For pending tasks this is correct since pending tasks cannot hold file locks.
  // If a task is released back to pending while the agent still holds files,
  // the block reason may incorrectly include the original agent's locks.
  const getFileConflictsForTask = db.prepare(
    `SELECT f.path, f.claimant FROM task_files tf
     JOIN files f ON f.path = tf.file_path
     WHERE tf.task_id = ? AND f.claimant IS NOT NULL`
  );

  const deleteTask = db.prepare('DELETE FROM tasks WHERE id = @id AND status NOT IN (\'claimed\', \'in_progress\')');

  /** True if a string field has a meaningful value (not null, undefined, or empty string). */
  function hasValue(v: string | null | undefined): boolean {
    return v !== null && v !== undefined && v !== '';
  }

  /** Validate sourcePath against the main project worktree (design team's canonical branch). */
  function getValidationWorktree(): string {
    return config.project.path;
  }

  function getBareRepoPath(): string {
    return config.server.bareRepoPath;
  }

  /** Returns unknown field names from a request body, inferred from a type's keys. */
  function unknownFields<T>(body: unknown, known: { [K in keyof T]: true }): string[] {
    if (typeof body !== 'object' || body === null) return [];
    return Object.keys(body).filter(k => !(k in known));
  }

  /** Validate file paths: must be relative, no .., no empty strings. */
  function validateFilePaths(files: string[]): string | null {
    for (const f of files) {
      if (!f || f.startsWith('/') || f.includes('..') || f.trim() === '') {
        return `Invalid file path: '${f}'. Paths must be relative, non-empty, with no '..' components.`;
      }
    }
    return null;
  }

  /** Register files and link them to a task. Must be called within a transaction. */
  function linkFilesToTask(taskId: number, files: string[]): void {
    for (const f of files) {
      insertFile.run(f);
      insertTaskFile.run(taskId, f);
    }
  }

  function linkDepsToTask(taskId: number, depIds: number[]): void {
    for (const depId of depIds) insertDep.run(taskId, depId);
  }

  function filesForTask(taskId: number): string[] {
    return (getTaskFiles.all(taskId) as { file_path: string }[]).map(r => r.file_path);
  }

  function depsForTask(taskId: number): number[] {
    return (getDepsForTask.all(taskId) as { depends_on: number }[]).map(r => r.depends_on);
  }

  function blockersForTask(taskId: number, agent: string): number[] {
    const incomplete = (getIncompleteBlockersForTask.all(taskId) as { depends_on: number }[]).map(r => r.depends_on);
    const wrongBranch = (getWrongBranchBlockersForTask.all(taskId, agent) as { depends_on: number }[]).map(r => r.depends_on);
    return [...incomplete, ...wrongBranch];
  }

  function blockReasonsForTask(row: TaskRow, agent: string): string[] {
    if (row.status !== 'pending') return [];
    const reasons: string[] = [];

    // Missing sourcePath check
    if (row.source_path) {
      const bareRepo = config.server.bareRepoPath;
      if (bareRepo) {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
        // NOTE: existsInBareRepo runs git cat-file synchronously per pending task.
        // For large queues (50+ pending tasks with sourcePaths), this could cause
        // latency spikes. Consider batch validation or caching if this becomes
        // a bottleneck in practice.
        if (!existsInBareRepo(bareRepo, planBranch, row.source_path)) {
          reasons.push(`sourcePath '${row.source_path}' not found on ${planBranch}`);
        }
      }
    }

    // File-lock conflicts
    const conflicts = getFileConflictsForTask.all(row.id) as { path: string; claimant: string }[];
    if (conflicts.length > 0) {
      const byClaimant = new Map<string, string[]>();
      for (const c of conflicts) {
        const list = byClaimant.get(c.claimant) ?? [];
        list.push(c.path);
        byClaimant.set(c.claimant, list);
      }
      for (const [claimant, paths] of byClaimant) {
        reasons.push(`files locked by agent '${claimant}': ${paths.join(', ')}`);
      }
    }

    // Unmet dependencies — incomplete (not completed/integrated)
    const incomplete = (getIncompleteBlockersForTask.all(row.id) as { depends_on: number }[]).map(r => r.depends_on);
    if (incomplete.length > 0) {
      reasons.push(`blocked by incomplete task(s): #${incomplete.join(', #')}`);
    }

    // Unmet dependencies — completed on a different agent's branch
    const wrongBranch = (getWrongBranchBlockersForTask.all(row.id, agent) as { depends_on: number }[]).map(r => r.depends_on);
    if (wrongBranch.length > 0) {
      reasons.push(`blocked by work on another branch: #${wrongBranch.join(', #')}`);
    }

    return reasons;
  }

  function formatTaskWithFiles(row: TaskRow, agent: string) {
    const reasons = blockReasonsForTask(row, agent);
    return formatTask(row, filesForTask(row.id), depsForTask(row.id), blockersForTask(row.id, agent), reasons);
  }

  function checkAndClaimFiles(taskId: number, agent: string): ConflictInfo[] | null {
    const deps = (getTaskFiles.all(taskId) as { file_path: string }[]).map(r => r.file_path);
    if (deps.length === 0) return null;

    const conflictRows = getFileConflicts.all(taskId, agent) as { path: string; claimant: string }[];

    if (conflictRows.length > 0) {
      return conflictRows.map(r => ({ file: r.path, claimant: r.claimant }));
    }

    for (const dep of deps) {
      claimFilesForAgent.run(agent, dep);
    }
    return [];
  }

  return {
    insertTask,
    getTaskById,
    claimTask,
    updateProgress,
    completeTask,
    failTask,
    releaseTask,
    resetTask,
    integrateTask,
    integrateBatch,
    integrateAll,
    selectCompletedByAgent,
    selectAllCompleted,
    insertFile,
    insertTaskFile,
    getTaskFiles,
    deleteTaskFiles,
    insertDep,
    getDepsForTask,
    getIncompleteBlockersForTask,
    getWrongBranchBlockersForTask,
    deleteDepsForTask,
    claimFilesForAgent,
    getFileConflicts,
    getFileConflictsForTask,
    deleteTask,
    hasValue,
    getValidationWorktree,
    getBareRepoPath,
    validateFilePaths,
    unknownFields,
    linkFilesToTask,
    linkDepsToTask,
    filesForTask,
    depsForTask,
    blockersForTask,
    blockReasonsForTask,
    formatTaskWithFiles,
    checkAndClaimFiles,
  };
}
