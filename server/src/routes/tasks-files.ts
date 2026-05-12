import type { ScaffoldConfig } from "../config.js";
import { existsInBareRepo } from "../git-utils.js";
import { seedBranchFor } from "../branch-naming.js";
import { getDb } from "../drizzle-instance.js";
import * as tasksCore from "../queries/tasks-core.js";
import * as taskFilesQ from "../queries/task-files.js";
import * as taskDepsQ from "../queries/task-deps.js";
import * as compositionQ from "../queries/composition.js";
import { formatTask, type TaskRow } from "./tasks-types.js";
import { resolveProject } from "../resolve-project.js";

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
  acceptanceCriteria: true,
  priority: true,
  files: true,
  targetAgents: true,
  dependsOn: true,
  dependsOnIndex: true,
};

export type PatchBody = Omit<TaskBody, "targetAgents" | "dependsOnIndex">;
export const patchBodyKeys: { [K in keyof Required<PatchBody>]: true } = {
  title: true,
  description: true,
  sourcePath: true,
  acceptanceCriteria: true,
  priority: true,
  files: true,
  dependsOn: true,
};

// ── Utility functions (no DB access) ──────────────────────────────

/** True if a string field has a meaningful value (not null, undefined, or empty string). */
export function hasValue(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && v !== "";
}

/** Returns unknown field names from a request body, inferred from a type's keys. */
export function unknownFields<T>(
  body: unknown,
  known: { [K in keyof T]: true },
): string[] {
  if (typeof body !== "object" || body === null) return [];
  return Object.keys(body).filter((k) => !(k in known));
}

/** Validate file paths: must be relative, no .., no empty strings. */
export function validateFilePaths(files: string[]): string | null {
  for (const f of files) {
    if (!f || f.startsWith("/") || f.includes("..") || f.trim() === "") {
      return `Invalid file path: '${f}'. Paths must be relative, non-empty, with no '..' components.`;
    }
  }
  return null;
}

// ── Composition functions (async, use Drizzle query modules) ──────

export async function linkFilesToTask(
  taskId: number,
  files: string[],
  projectId: string = "default",
): Promise<void> {
  const db = getDb();
  await compositionQ.linkFilesToTask(db, taskId, files, projectId);
}

export async function linkDepsToTask(
  taskId: number,
  depIds: number[],
): Promise<void> {
  const db = getDb();
  await compositionQ.linkDepsToTask(db, taskId, depIds);
}

export async function filesForTask(taskId: number): Promise<string[]> {
  const db = getDb();
  return taskFilesQ.getFilesForTask(db, taskId);
}

export async function depsForTask(taskId: number): Promise<number[]> {
  const db = getDb();
  return taskDepsQ.getDepsForTask(db, taskId);
}

/**
 * Return the dep task IDs that block claiming `taskId` from the perspective
 * of `agentId`. If `agentId` is null (anonymous reader, e.g. the dashboard
 * listing tasks without an agent context), only the "incomplete dep" set is
 * returned — the wrong-branch check is meaningless without a requester
 * identity to compare against.
 */
export async function blockersForTask(
  taskId: number,
  agentId: string | null,
): Promise<number[]> {
  const db = getDb();
  const incomplete = await taskDepsQ.getIncompleteBlockers(db, taskId);
  const wrongBranch = agentId
    ? await taskDepsQ.getWrongBranchBlockers(db, taskId, agentId)
    : [];
  return [...incomplete.map((r) => r.id), ...wrongBranch.map((r) => r.id)];
}

export async function blockReasonsForTask(
  row: TaskRow,
  agentId: string | null,
  config: ScaffoldConfig,
): Promise<string[]> {
  if (row.status !== "pending") return [];
  const db = getDb();
  const reasons: string[] = [];

  const sp = row.sourcePath;
  const projectId = row.projectId;

  // Missing sourcePath check
  if (sp) {
    try {
      const project = await resolveProject(config, db, projectId);
      const bareRepo = project.bareRepoPath;
      if (bareRepo) {
        const seedBranch = seedBranchFor(projectId, project);
        if (!existsInBareRepo(bareRepo, seedBranch, sp)) {
          reasons.push(`sourcePath '${sp}' not found on ${seedBranch}`);
        }
      }
    } catch {
      // Unknown project — skip sourcePath validation rather than crashing
    }
  }

  // File-lock conflicts
  const conflicts = await taskFilesQ.getFileConflicts(db, row.id);
  const nonNullConflicts = conflicts.filter((c) => c.claimant !== null);
  if (nonNullConflicts.length > 0) {
    const byClaimant = new Map<string, string[]>();
    for (const c of nonNullConflicts) {
      const list = byClaimant.get(c.claimant!) ?? [];
      list.push(c.path);
      byClaimant.set(c.claimant!, list);
    }
    for (const [claimant, paths] of byClaimant) {
      reasons.push(`files locked by agent '${claimant}': ${paths.join(", ")}`);
    }
  }

  // Unmet dependencies — incomplete (not completed/integrated)
  const incomplete = await taskDepsQ.getIncompleteBlockers(db, row.id);
  if (incomplete.length > 0) {
    reasons.push(
      `blocked by incomplete task(s): #${incomplete.map((r) => r.id).join(", #")}`,
    );
  }

  // Unmet dependencies — completed on a different agent's branch. Only
  // meaningful when we have a requester identity; anonymous readers skip
  // this reason entirely.
  if (agentId) {
    const wrongBranch = await taskDepsQ.getWrongBranchBlockers(
      db,
      row.id,
      agentId,
    );
    if (wrongBranch.length > 0) {
      reasons.push(
        `blocked by work on another branch: #${wrongBranch.map((r) => r.id).join(", #")}`,
      );
    }
  }

  return reasons;
}

export async function formatTaskWithFiles(
  row: TaskRow,
  agentId: string | null,
  config: ScaffoldConfig,
) {
  const [files, deps, blockers, reasons] = await Promise.all([
    filesForTask(row.id),
    depsForTask(row.id),
    blockersForTask(row.id, agentId),
    blockReasonsForTask(row, agentId, config),
  ]);
  return formatTask(row, files, deps, blockers, reasons);
}

export async function checkAndClaimFiles(
  taskId: number,
  agentId: string,
): Promise<ConflictInfo[] | null> {
  const db = getDb();
  const deps = await taskFilesQ.getFilesForTask(db, taskId);
  if (deps.length === 0) return null;

  const conflictRows = await taskFilesQ.getFileConflicts(db, taskId, agentId);

  if (conflictRows.length > 0) {
    return conflictRows.map((r) => ({ file: r.path, claimant: r.claimant! }));
  }

  const taskRow = await tasksCore.getById(db, taskId);
  const projectId = taskRow?.projectId ?? "default";
  for (const dep of deps) {
    await taskFilesQ.claimFilesForAgent(db, agentId, projectId, dep);
  }
  return [];
}
