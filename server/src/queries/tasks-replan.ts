import { eq, sql } from 'drizzle-orm';
import { tasks, taskDependencies } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function getNonTerminalTasks(db: DrizzleDb) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      basePriority: tasks.basePriority,
    })
    .from(tasks)
    .where(sql`${tasks.status} NOT IN ('completed', 'failed', 'integrated')`);
}

export async function getNonTerminalDeps(db: DrizzleDb) {
  const rows = await db.execute(sql`
    SELECT td.task_id as "taskId", td.depends_on as "dependsOn"
    FROM task_dependencies td
    INNER JOIN tasks t ON t.id = td.task_id
    INNER JOIN tasks dep ON dep.id = td.depends_on
    WHERE t.status NOT IN ('completed', 'failed', 'integrated')
      AND dep.status NOT IN ('completed', 'failed', 'integrated')
  `);
  return (rows.rows as Array<{ taskId: number; dependsOn: number }>).map((r) => ({
    taskId: Number(r.taskId),
    dependsOn: Number(r.dependsOn),
  }));
}

export async function markCycle(db: DrizzleDb, id: number) {
  await db
    .update(tasks)
    .set({ status: 'cycle' })
    .where(eq(tasks.id, id));
}

export async function setPriority(db: DrizzleDb, id: number, priority: number) {
  await db
    .update(tasks)
    .set({ priority })
    .where(eq(tasks.id, id));
}
