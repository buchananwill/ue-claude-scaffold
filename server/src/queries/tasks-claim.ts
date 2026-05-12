import { eq, and, sql, count as countFn } from "drizzle-orm";
import { tasks } from "../schema/tables.js";
import type { DrizzleDb } from "../drizzle-instance.js";

/**
 * Find up to 10 claimable pending tasks, sorted by affinity and priority.
 *
 * Dependency-satisfaction predicate, per the durable-task FSM contract:
 *   * `dep.status = 'integrated'` — the dep's work has been merged to the
 *     seed branch by an operator; any agent can claim downstream tasks.
 *   * `dep.status = 'completed' AND dep.claimed_by_agent_id = ${agentId}` —
 *     the dep is finished and reviewed but its work is still on the
 *     completing agent's git branch. Only that same agent (matched by UUID
 *     identity, preserved across container restarts via the
 *     `(project_id, name) -> id` upsert) can claim a downstream task without
 *     a separate merge step.
 *
 * The pre-FSM `result.agent` JSON column is no longer populated by
 * `applyTransition`, so comparisons against it would always evaluate NULL
 * and silently block every downstream task. The check moved to the FSM-
 * native `claimed_by_agent_id` UUID column.
 *
 * @param agentId - UUID of the requesting agent. Used for file-lock
 *                  ownership and for the same-branch dep-satisfaction
 *                  predicate above.
 */
export async function claimNextCandidate(
  db: DrizzleDb,
  projectId: string,
  agentId: string,
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
        WHERE tf2.task_id = t.id AND f2.claimant_agent_id IS NOT NULL AND f2.claimant_agent_id != ${agentId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id
          AND NOT (dep.status = 'integrated' OR (dep.status = 'completed' AND dep.claimed_by_agent_id = ${agentId}))
      )
    GROUP BY t.id, t.priority
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id AND dep.status = 'completed' AND dep.claimed_by_agent_id = ${agentId}
      ) THEN 0 ELSE 1 END ASC,
      new_locks ASC, t.priority DESC, t.id ASC
    LIMIT 10
  `);

  return (rows.rows as Array<{ id: number; new_locks: string | number }>).map(
    (r) => ({
      id: Number(r.id),
      newLocks: Number(r.new_locks),
    }),
  );
}

export async function countPending(
  db: DrizzleDb,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(and(eq(tasks.status, "pending"), eq(tasks.projectId, projectId)));
  return Number(rows[0].count);
}

/** Count tasks blocked by file ownership. agentId is a UUID (compared against claimant_agent_id). */
export async function countBlocked(
  db: DrizzleDb,
  projectId: string,
  agentId: string,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT t.id) as count
    FROM tasks t
    JOIN task_files tf ON tf.task_id = t.id
    JOIN files f ON f.project_id = t.project_id AND f.path = tf.file_path
    WHERE t.status = 'pending'
      AND t.project_id = ${projectId}
      AND f.claimant_agent_id IS NOT NULL
      AND f.claimant_agent_id != ${agentId}
  `);
  return Number((result.rows[0] as { count: string | number }).count);
}

/**
 * Count tasks blocked by unmet dependencies, from the perspective of a
 * given agent. Dependency-satisfaction predicate matches `claimNextCandidate`:
 * the dep counts as satisfied iff it is `integrated`, or it is `completed`
 * and was claimed by the same agent UUID (the work commits then live on the
 * requester's git branch).
 *
 * @param agentId - UUID of the requesting agent.
 */
export async function countDepBlocked(
  db: DrizzleDb,
  projectId: string,
  agentId: string,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT t.id) as count
    FROM tasks t
    JOIN task_dependencies d ON d.task_id = t.id
    JOIN tasks dep ON dep.id = d.depends_on
    WHERE t.status = 'pending'
      AND t.project_id = ${projectId}
      AND NOT (dep.status = 'integrated' OR (dep.status = 'completed' AND dep.claimed_by_agent_id = ${agentId}))
  `);
  return Number((result.rows[0] as { count: string | number }).count);
}
