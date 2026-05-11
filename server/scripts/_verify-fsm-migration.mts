import { PGlite } from "@electric-sql/pglite";

const dir = process.argv[2] ?? "./data/pglite-fsm-test";
const pglite = new PGlite(dir);

let allOk = true;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "OK  " : "FAIL";
  if (!ok) allOk = false;
  console.log(`  [${mark}] ${label}${detail ? `  — ${detail}` : ""}`);
}

console.log("=== Archive table presence + row counts ===");
const expectedArchiveCounts: Record<string, number> = {
  tasks_pre_fsm_archive: 392,
  task_files_pre_fsm_archive: 1163,
  task_dependencies_pre_fsm_archive: 294,
  claude_code_container_sessions_pre_fsm_archive: 0,
};
for (const [t, expected] of Object.entries(expectedArchiveCounts)) {
  const r = await pglite.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${t}"`);
  check(`${t}.count == ${expected}`, r.rows[0].c === expected, `actual ${r.rows[0].c}`);
}

console.log("\n=== New table presence + emptiness ===");
const newTables = [
  "tasks", "task_files", "task_dependencies", "claude_code_container_sessions",
  "review_runs", "arbitration_runs", "review_findings",
];
for (const t of newTables) {
  try {
    const r = await pglite.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${t}"`);
    check(`${t} exists and is empty`, r.rows[0].c === 0, `count ${r.rows[0].c}`);
  } catch (e) {
    check(`${t} exists`, false, (e as Error).message);
  }
}

console.log("\n=== tasks status CHECK ===");
try {
  await pglite.query(
    `INSERT INTO tasks (project_id, title, status) VALUES ('piste-perfect', '__probe_engineering__', 'engineering')`,
  );
  check("status=engineering accepted", true);
  await pglite.query(`DELETE FROM tasks WHERE title='__probe_engineering__'`);
} catch (e) {
  check("status=engineering accepted", false, (e as Error).message);
}
try {
  await pglite.query(
    `INSERT INTO tasks (project_id, title, status) VALUES ('piste-perfect', '__probe_in_progress__', 'in_progress')`,
  );
  check("legacy status=in_progress rejected", false, "INSERT unexpectedly succeeded");
  await pglite.query(`DELETE FROM tasks WHERE title='__probe_in_progress__'`);
} catch {
  check("legacy status=in_progress rejected", true);
}

console.log("\n=== tasks build_status CHECK ===");
try {
  await pglite.query(
    `INSERT INTO tasks (project_id, title, build_status) VALUES ('piste-perfect', '__probe_garbage_bs__', 'garbage')`,
  );
  check("build_status=garbage rejected", false);
  await pglite.query(`DELETE FROM tasks WHERE title='__probe_garbage_bs__'`);
} catch {
  check("build_status=garbage rejected", true);
}

console.log("\n=== tasks failure_reason CHECK ===");
try {
  await pglite.query(
    `INSERT INTO tasks (project_id, title, failure_reason) VALUES ('piste-perfect', '__probe_invalid_fr__', 'not_in_enum')`,
  );
  check("failure_reason=not_in_enum rejected", false);
  await pglite.query(`DELETE FROM tasks WHERE title='__probe_invalid_fr__'`);
} catch {
  check("failure_reason=not_in_enum rejected", true);
}
try {
  await pglite.query(
    `INSERT INTO tasks (project_id, title, failure_reason) VALUES ('piste-perfect', '__probe_valid_fr__', 'engineer_build_failure')`,
  );
  check("failure_reason=engineer_build_failure accepted", true);
  await pglite.query(`DELETE FROM tasks WHERE title='__probe_valid_fr__'`);
} catch (e) {
  check("failure_reason=engineer_build_failure accepted", false, (e as Error).message);
}

console.log("\n=== review_runs unique (task,cycle,role) ===");
const taskInsert = await pglite.query<{ id: number }>(
  `INSERT INTO tasks (project_id, title) VALUES ('piste-perfect', '__probe_unique__') RETURNING id`,
);
const taskId = taskInsert.rows[0].id;
try {
  await pglite.query(
    `INSERT INTO review_runs (task_id, cycle, reviewer_role, verdict, raw_markdown) VALUES ($1, 1, 'safety', 'approve', '')`,
    [taskId],
  );
  check("first review_run insert succeeds", true);
} catch (e) {
  check("first review_run insert succeeds", false, (e as Error).message);
}
try {
  await pglite.query(
    `INSERT INTO review_runs (task_id, cycle, reviewer_role, verdict, raw_markdown) VALUES ($1, 1, 'safety', 'request_changes', '')`,
    [taskId],
  );
  check("duplicate (task,cycle,role) review_run rejected", false);
} catch {
  check("duplicate (task,cycle,role) review_run rejected", true);
}

console.log("\n=== arbitration_runs rule-requires-resolution CHECK ===");
try {
  await pglite.query(
    `INSERT INTO arbitration_runs (task_id, trigger, ruling, ruling_markdown) VALUES ($1, 'reviewer_contradiction', 'rule', '')`,
    [taskId],
  );
  check("ruling=rule with NULL contradiction_resolution rejected", false);
} catch {
  check("ruling=rule with NULL contradiction_resolution rejected", true);
}
try {
  await pglite.query(
    `INSERT INTO arbitration_runs (task_id, trigger, ruling, ruling_markdown, contradiction_resolution)
     VALUES ($1, 'reviewer_contradiction', 'rule', '', '{"upheld":1,"retired":2}'::jsonb)`,
    [taskId],
  );
  check("ruling=rule with non-NULL contradiction_resolution accepted", true);
} catch (e) {
  check("ruling=rule with non-NULL contradiction_resolution accepted", false, (e as Error).message);
}

console.log("\n=== projects.agent_roles intentionally absent ===");
const absentCheck = await pglite.query<{ exists: boolean }>(
  `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='projects' AND column_name='agent_roles') AS exists`,
);
check("projects.agent_roles does NOT exist (operator-local config, lives in scaffold.config.json)", !absentCheck.rows[0].exists);

console.log("\n=== Archive FK target survives (structural test) ===");
const archiveFkInfo = await pglite.query<{ confrelid_name: string }>(
  `SELECT cf.relname AS confrelid_name
   FROM pg_constraint c
   JOIN pg_class cl ON cl.oid = c.conrelid
   JOIN pg_class cf ON cf.oid = c.confrelid
   JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public'
     AND cl.relname = 'claude_code_container_sessions_pre_fsm_archive'
     AND c.contype = 'f'
     AND c.conname LIKE '%task_id%'`,
);
check(
  "archived ccs.task_id FK targets archived tasks table",
  archiveFkInfo.rows[0]?.confrelid_name === "tasks_pre_fsm_archive",
  `targets ${archiveFkInfo.rows[0]?.confrelid_name}`,
);

console.log("\n=== New ccs FK points at new tasks ===");
const fkInfo = await pglite.query<{ confrelid_name: string }>(
  `SELECT cf.relname AS confrelid_name
   FROM pg_constraint c
   JOIN pg_class cl ON cl.oid = c.conrelid
   JOIN pg_class cf ON cf.oid = c.confrelid
   JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public'
     AND cl.relname = 'claude_code_container_sessions'
     AND c.contype = 'f'
     AND c.conname LIKE '%task_id%'`,
);
check(
  "new ccs.task_id FK targets new tasks table",
  fkInfo.rows[0]?.confrelid_name === "tasks",
  `targets ${fkInfo.rows[0]?.confrelid_name}`,
);

await pglite.query(`DELETE FROM tasks WHERE title='__probe_unique__'`);

console.log("\n=== Final counts ===");
const fkCount = await pglite.query<{ c: number }>(
  `SELECT count(*)::int AS c FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = 'public' AND c.contype = 'f'`,
);
console.log(`  total FKs in public: ${fkCount.rows[0].c}`);
const indexCount = await pglite.query<{ c: number }>(
  `SELECT count(*)::int AS c FROM pg_indexes WHERE schemaname = 'public'`,
);
console.log(`  total indexes in public: ${indexCount.rows[0].c}`);
const tableCount = await pglite.query<{ c: number }>(
  `SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = 'public'`,
);
console.log(`  total tables in public: ${tableCount.rows[0].c}`);

await pglite.close();
console.log(allOk ? "\n*** ALL CHECKS PASSED ***" : "\n*** SOME CHECKS FAILED ***");
process.exit(allOk ? 0 : 1);
