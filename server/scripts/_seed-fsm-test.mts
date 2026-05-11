import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";

const dir = process.argv[2] ?? "./data/pglite-fsm-test";
const pglite = new PGlite(dir);

// Pick the first 3 existing tasks (with their project_id) and the first existing agent.
const tasks = await pglite.query<{ id: number; project_id: string }>(
  `SELECT id, project_id FROM tasks ORDER BY id LIMIT 3`
);
if (tasks.rows.length < 3) {
  console.error(`Need at least 3 tasks to seed, found ${tasks.rows.length}`);
  process.exit(1);
}

const agentRow = await pglite.query<{ id: string; project_id: string }>(
  `SELECT id, project_id FROM agents WHERE project_id = $1 LIMIT 1`,
  [tasks.rows[0].project_id],
);
if (agentRow.rows.length === 0) {
  console.error(`No agent found for project ${tasks.rows[0].project_id}`);
  process.exit(1);
}
const agentId = agentRow.rows[0].id;

console.log(`Seeding 3 claude_code_container_sessions rows…`);
for (const t of tasks.rows) {
  const id = randomUUID();
  await pglite.query(
    `INSERT INTO claude_code_container_sessions
       (id, project_id, agent_id, task_id, status, exit_code)
     VALUES ($1, $2, $3, $4, 'complete', 0)`,
    [id, t.project_id, agentId, t.id],
  );
  console.log(`  ${id} → task ${t.id} (project ${t.project_id})`);
}

const out = await pglite.query<{
  id: string;
  task_id: number;
  status: string;
}>(`SELECT id, task_id, status FROM claude_code_container_sessions ORDER BY started_at`);
console.log(`\nVerify (${out.rows.length} rows):`);
for (const r of out.rows) console.log(`  ${r.id}  task_id=${r.task_id}  status=${r.status}`);

await pglite.close();
