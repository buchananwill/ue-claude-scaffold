import { eq, and, isNull, sql } from 'drizzle-orm';
import { files, taskFiles, tasks } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function insertFile(db: DrizzleDb, projectId: string, path: string) {
  await db
    .insert(files)
    .values({ projectId, path })
    .onConflictDoNothing();
}

export async function linkFileToTask(db: DrizzleDb, taskId: number, filePath: string) {
  await db
    .insert(taskFiles)
    .values({ taskId, filePath });
}

export async function getFilesForTask(db: DrizzleDb, taskId: number) {
  const rows = await db
    .select({ filePath: taskFiles.filePath })
    .from(taskFiles)
    .where(eq(taskFiles.taskId, taskId));
  return rows.map((r) => r.filePath);
}

export async function deleteFilesForTask(db: DrizzleDb, taskId: number) {
  await db
    .delete(taskFiles)
    .where(eq(taskFiles.taskId, taskId));
}

export async function claimFilesForAgent(
  db: DrizzleDb,
  agent: string,
  projectId: string,
  path: string,
): Promise<boolean> {
  const rows = await db
    .update(files)
    .set({ claimantAgentId: agent, claimedAt: sql`now()` })
    .where(
      and(
        eq(files.projectId, projectId),
        eq(files.path, path),
        isNull(files.claimantAgentId),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function getFileConflicts(
  db: DrizzleDb,
  taskId: number,
  agent: string,
): Promise<{ path: string; claimant: string }[]> {
  const rows = await db
    .select({
      path: taskFiles.filePath,
      // API-compat: external consumers see "claimant"; internal column is claimantAgentId
      claimant: files.claimantAgentId,
    })
    .from(taskFiles)
    .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
    .innerJoin(
      files,
      and(
        eq(files.projectId, tasks.projectId),
        eq(files.path, taskFiles.filePath),
      ),
    )
    .where(
      and(
        eq(taskFiles.taskId, taskId),
        sql`${files.claimantAgentId} IS NOT NULL`,
        sql`${files.claimantAgentId} != ${agent}`,
      ),
    );

  return rows.map((r) => ({ path: r.path, claimant: r.claimant! }));
}

export async function getFileConflictsForTask(
  db: DrizzleDb,
  taskId: number,
): Promise<{ path: string; claimant: string | null }[]> {
  const rows = await db
    .select({
      path: taskFiles.filePath,
      // API-compat: external consumers see "claimant"; internal column is claimantAgentId
      claimant: files.claimantAgentId,
    })
    .from(taskFiles)
    .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
    .innerJoin(
      files,
      and(
        eq(files.projectId, tasks.projectId),
        eq(files.path, taskFiles.filePath),
      ),
    )
    .where(
      and(
        eq(taskFiles.taskId, taskId),
        sql`${files.claimantAgentId} IS NOT NULL`,
      ),
    );

  return rows.map((r) => ({ path: r.path, claimant: r.claimant }));
}
