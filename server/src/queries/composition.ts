import { insertFile, linkFileToTask, claimFilesForAgent } from './task-files.js';
import { insertDep } from './task-deps.js';
import type { DrizzleDb } from '../drizzle-instance.js';

/**
 * For each file: insert into files table, link to task, optionally claim for agent.
 */
export async function linkFilesToTask(
  db: DrizzleDb,
  taskId: number,
  filePaths: string[],
  projectId: string,
  agent?: string,
) {
  for (const filePath of filePaths) {
    await insertFile(db, projectId, filePath);
    await linkFileToTask(db, taskId, filePath);
    if (agent) {
      await claimFilesForAgent(db, agent, projectId, filePath);
    }
  }
}

/**
 * For each dep ID: insert a task dependency.
 */
export async function linkDepsToTask(
  db: DrizzleDb,
  taskId: number,
  depIds: number[],
) {
  for (const depId of depIds) {
    await insertDep(db, taskId, depId);
  }
}
