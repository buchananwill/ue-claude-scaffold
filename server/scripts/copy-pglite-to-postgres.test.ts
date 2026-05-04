/**
 * Unit test for the copy engine. Uses two in-memory PGlite instances —
 * one as source, one as target — exercising the same SQL the production
 * driver issues against pg.Pool. The wire protocol differs only at the
 * connection layer; the SQL is portable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  runCopy,
  type SourceAdapter,
  type TargetAdapter,
  type QueryRow,
  type TableSpec,
} from "./copy-pglite-to-postgres.js";

/** Minimal schema for the test — covers FK chain, jsonb, serial PK, and self-FK. */
const TEST_SCHEMA_DDL = `
  CREATE TABLE "projects" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL
  );
  CREATE TABLE "agents" (
    "id" uuid PRIMARY KEY,
    "project_id" text NOT NULL REFERENCES "projects"("id"),
    "name" text NOT NULL
  );
  CREATE TABLE "tasks" (
    "id" serial PRIMARY KEY,
    "project_id" text NOT NULL REFERENCES "projects"("id"),
    "title" text NOT NULL,
    "result" jsonb
  );
  CREATE TABLE "chat_messages" (
    "id" serial PRIMARY KEY,
    "content" text NOT NULL,
    "reply_to" integer REFERENCES "chat_messages"("id") ON DELETE SET NULL
  );
`;

const TEST_TABLES: readonly TableSpec[] = [
  { name: "projects", hasSerialPk: false, orderBy: "id" },
  { name: "agents", hasSerialPk: false, orderBy: "id" },
  { name: "tasks", hasSerialPk: true, orderBy: "id", jsonbColumns: ["result"] },
  { name: "chat_messages", hasSerialPk: true, orderBy: "id" },
];

function makePgliteAdapter(client: PGlite): SourceAdapter & TargetAdapter {
  return {
    query: async (sql, params) => {
      const r = await client.query(sql, params as unknown[]);
      return { rows: r.rows as QueryRow[] };
    },
    withTransaction: async (fn) => {
      let captured: unknown;
      let result: unknown;
      await client
        .transaction(async (tx) => {
          result = await fn(async (sql, params) => {
            const r = await tx.query(sql, params as unknown[]);
            return { rows: r.rows as QueryRow[] };
          });
        })
        .catch((e) => {
          captured = e;
        });
      if (captured) throw captured;
      return result as Awaited<ReturnType<typeof fn>>;
    },
  };
}

async function makeTestClient(): Promise<PGlite> {
  const c = new PGlite();
  await c.exec("SET timezone TO 'UTC'");
  await c.exec(TEST_SCHEMA_DDL);
  return c;
}

describe("runCopy", () => {
  it("copies all rows from source to empty target with FK + jsonb + serial PK roundtrip", async () => {
    const sourceClient = await makeTestClient();
    const targetClient = await makeTestClient();

    try {
      // Seed source.
      await sourceClient.query(
        `INSERT INTO projects (id, name) VALUES ($1, $2), ($3, $4)`,
        ["p1", "Project 1", "p2", "Project 2"],
      );
      const a1 = "00000000-0000-0000-0000-000000000001";
      const a2 = "00000000-0000-0000-0000-000000000002";
      await sourceClient.query(
        `INSERT INTO agents (id, project_id, name) VALUES ($1, $2, $3), ($4, $5, $6)`,
        [a1, "p1", "agent-1", a2, "p2", "agent-2"],
      );
      await sourceClient.query(
        `INSERT INTO tasks (project_id, title, result) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
        [
          "p1",
          "task one",
          JSON.stringify({ ok: true, items: [1, 2, 3] }),
          "p2",
          "task two",
          null,
          "p1",
          "task three",
          // jsonb scalar string — PGlite returns this as a JS string, not an
          // object. Regression coverage for Phase 5 cutover bug.
          JSON.stringify("Fixed waitgroup bloat and ack mismatch"),
        ],
      );
      // chat_messages with self-FK: row 2 replies to row 1.
      await sourceClient.query(
        `INSERT INTO chat_messages (content, reply_to) VALUES ($1, $2)`,
        ["hello", null],
      );
      await sourceClient.query(
        `INSERT INTO chat_messages (content, reply_to) VALUES ($1, $2)`,
        ["hi back", 1],
      );

      const source = makePgliteAdapter(sourceClient);
      const target = makePgliteAdapter(targetClient);
      const logs: string[] = [];

      const result = await runCopy({
        source,
        target,
        tables: TEST_TABLES,
        log: (m) => logs.push(m),
      });

      // Per-table counts.
      const byTable = Object.fromEntries(
        result.perTable.map((p) => [p.table, p]),
      );
      assert.equal(byTable.projects.rowsRead, 2);
      assert.equal(byTable.projects.rowsWritten, 2);
      assert.equal(byTable.agents.rowsRead, 2);
      assert.equal(byTable.agents.rowsWritten, 2);
      assert.equal(byTable.tasks.rowsRead, 3);
      assert.equal(byTable.tasks.rowsWritten, 3);
      assert.equal(byTable.chat_messages.rowsRead, 2);
      assert.equal(byTable.chat_messages.rowsWritten, 2);
      assert.equal(result.totalRowsRead, 9);
      assert.equal(result.totalRowsWritten, 9);

      // Target row counts.
      for (const t of TEST_TABLES) {
        const r = await targetClient.query(
          `SELECT count(*)::int AS c FROM "${t.name}"`,
        );
        const c = (r.rows[0] as { c: number }).c;
        assert.equal(c, byTable[t.name].rowsRead, `${t.name} count mismatch`);
      }

      // jsonb roundtrip — object value must survive as a parsed object on the target.
      const taskRows = await targetClient.query(
        `SELECT result FROM tasks WHERE title = 'task one'`,
      );
      const result0 = (taskRows.rows[0] as { result: unknown }).result;
      assert.deepEqual(result0, { ok: true, items: [1, 2, 3] });

      // jsonb scalar roundtrip — string value stored in a jsonb column must
      // come back as a JS string. Regression coverage for the cutover bug.
      const scalarTaskRow = await targetClient.query(
        `SELECT result FROM tasks WHERE title = 'task three'`,
      );
      const result2 = (scalarTaskRow.rows[0] as { result: unknown }).result;
      assert.equal(result2, "Fixed waitgroup bloat and ack mismatch");

      // Self-FK preserved.
      const chatRows = await targetClient.query(
        `SELECT id, reply_to FROM chat_messages ORDER BY id`,
      );
      assert.equal(
        (chatRows.rows[0] as { reply_to: number | null }).reply_to,
        null,
      );
      assert.equal(
        (chatRows.rows[1] as { reply_to: number | null }).reply_to,
        1,
      );

      // Sequence reset — next insert into tasks must get id = 3.
      const ins = await targetClient.query(
        `INSERT INTO tasks (project_id, title) VALUES ('p1', 'task next') RETURNING id`,
      );
      assert.equal((ins.rows[0] as { id: number }).id, 4);
    } finally {
      await sourceClient.close();
      await targetClient.close();
    }
  });

  it("aborts when target is non-empty", async () => {
    const sourceClient = await makeTestClient();
    const targetClient = await makeTestClient();
    try {
      await sourceClient.query(
        `INSERT INTO projects (id, name) VALUES ('p1','P1')`,
      );
      await targetClient.query(
        `INSERT INTO projects (id, name) VALUES ('seed','seed')`,
      );

      const source = makePgliteAdapter(sourceClient);
      const target = makePgliteAdapter(targetClient);

      await assert.rejects(
        runCopy({ source, target, tables: TEST_TABLES, log: () => {} }),
        /Target is not empty/,
      );

      // Source untouched.
      const c = await sourceClient.query(
        `SELECT count(*)::int AS c FROM projects`,
      );
      assert.equal((c.rows[0] as { c: number }).c, 1);
    } finally {
      await sourceClient.close();
      await targetClient.close();
    }
  });

  it("dry-run logs counts and writes nothing", async () => {
    const sourceClient = await makeTestClient();
    const targetClient = await makeTestClient();
    try {
      await sourceClient.query(
        `INSERT INTO projects (id, name) VALUES ('p1','P1'),('p2','P2')`,
      );

      const source = makePgliteAdapter(sourceClient);
      const target = makePgliteAdapter(targetClient);
      const logs: string[] = [];

      const result = await runCopy({
        source,
        target,
        tables: TEST_TABLES,
        dryRun: true,
        log: (m) => logs.push(m),
      });

      assert.equal(result.totalRowsRead, 2);
      assert.equal(result.totalRowsWritten, 0);

      const c = await targetClient.query(
        `SELECT count(*)::int AS c FROM projects`,
      );
      assert.equal((c.rows[0] as { c: number }).c, 0);
      assert.ok(logs.some((m) => m.includes("projects: 2 rows (dry-run)")));
    } finally {
      await sourceClient.close();
      await targetClient.close();
    }
  });
});
