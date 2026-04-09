import { eq, and, sql, count as countFn } from 'drizzle-orm';
import { tasks } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function claimNextCandidate(
  db: DrizzleDb,
  projectId: string,
  agent: string,
): Promise<{ id: number; newLocks: number }[]> {
  const rows = await db.execute(sql`
    SELECT t.id,
      COUNT(CASE WHEN tf.file_path IS NOT NULL AND f.claimant_agent_id IS NULL THEN 1 END) as new_locks
    FROM tasks t
    LEFT JOIN task_files tf ON tf.task_id = t.id
    LEFT JOIN files f ON f.project_id = t.project_id AND f.path = tf.file_path
    WHERE t.status = 'pending'
      AND t.project_id = ${projectId}
      AND NOT EXISTS (
        SELECT 1 FROM task_files tf2
        JOIN files f2 ON f2.project_id = t.project_id AND f2.path = tf2.file_path
        WHERE tf2.task_id = t.id AND f2.claimant IS NOT NULL AND f2.claimant != ${agent}
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id
          AND NOT (dep.status = 'integrated' OR (dep.status = 'completed' AND dep.result->>'agent' = ${agent}))
      )
    GROUP BY t.id, t.priority
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id AND dep.status = 'completed' AND dep.result->>'agent' = ${agent}
      ) THEN 0 ELSE 1 END ASC,
      new_locks ASC, t.priority DESC, t.id ASC
    LIMIT 10
  `);

  return (rows.rows as Array<{ id: number; new_locks: string | number }>).map((r) => ({
    id: Number(r.id),
    newLocks: Number(r.new_locks),
  }));
}

export async function countPending(db: DrizzleDb, projectId: string): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), eq(tasks.projectId, projectId)));
  return Number(rows[0].count);
}

export async function countBlocked(db: DrizzleDb, projectId: string, agent: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT t.id) as count
    FROM tasks t
    JOIN task_files tf ON tf.task_id = t.id
    JOIN files f ON f.project_id = t.project_id AND f.path = tf.file_path
    WHERE t.status = 'pending'
      AND t.project_id = ${projectId}
      AND f.claimant_agent_id IS NOT NULL
      AND f.claimant_agent_id != ${agent}
  `);
  return Number((result.rows[0] as { count: string | number }).count);
}

export async function countDepBlocked(db: DrizzleDb, projectId: string, agent: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT t.id) as count
    FROM tasks t
    JOIN task_dependencies d ON d.task_id = t.id
    JOIN tasks dep ON dep.id = d.depends_on
    WHERE t.status = 'pending'
      AND t.project_id = ${projectId}
      AND NOT (dep.status = 'integrated' OR (dep.status = 'completed' AND dep.result->>'agent' = ${agent}))
  `);
  return Number((result.rows[0] as { count: string | number }).count);
}
