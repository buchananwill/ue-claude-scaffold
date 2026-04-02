import { eq, and, sql } from 'drizzle-orm';
import { taskDependencies, tasks } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function insertDep(db: DrizzleDb, taskId: number, dependsOn: number) {
  await db
    .insert(taskDependencies)
    .values({ taskId, dependsOn })
    .onConflictDoNothing();
}

export async function getDepsForTask(db: DrizzleDb, taskId: number) {
  const rows = await db
    .select({ dependsOn: taskDependencies.dependsOn })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId));
  return rows.map((r) => r.dependsOn);
}

export async function getIncompleteBlockers(db: DrizzleDb, taskId: number) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOn))
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        sql`${tasks.status} NOT IN ('completed', 'integrated')`,
      ),
    );
}

export async function getWrongBranchBlockers(db: DrizzleDb, taskId: number, agent: string) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOn))
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(tasks.status, 'completed'),
        sql`(${tasks.result}->>'agent' IS NULL OR ${tasks.result}->>'agent' != ${agent})`,
      ),
    );
}

export async function deleteDepsForTask(db: DrizzleDb, taskId: number) {
  await db
    .delete(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId));
}
