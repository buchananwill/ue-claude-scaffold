import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq } from 'drizzle-orm';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import { claudeCodeContainerSessions, tasks, projects, agents } from '../schema/tables.js';
import agentsPlugin from './agents.js';
import sessionsPlugin from './sessions.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build a test config that knows about both 'default' and 'proj-a'. */
function makeConfig() {
  const cfg = createTestConfig();
  cfg.resolvedProjects['proj-a'] = {
    name: 'Project A',
    path: '/tmp/proj-a',
    uprojectFile: '/tmp/proj-a/A.uproject',
    bareRepoPath: '/tmp/proj-a-repo.git',
  };
  return cfg;
}

describe('sessions routes (drizzle)', () => {
  let ctx: DrizzleTestContext;
  let agent1Id: string;
  let agent2Id: string;
  let taskId: number;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();

    // Shared test-utils SCHEMA_DDL doesn't yet include the
    // claude_code_container_sessions table. Install the table and its indexes
    // here so this test file is self-contained.
    await ctx.db.execute(sql`
      CREATE TABLE IF NOT EXISTS "claude_code_container_sessions" (
        "id" uuid PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "projects"("id"),
        "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE RESTRICT,
        "task_id" integer REFERENCES "tasks"("id") ON DELETE SET NULL,
        "status" text NOT NULL DEFAULT 'running',
        "started_at" timestamp NOT NULL DEFAULT now(),
        "ended_at" timestamp,
        "exit_code" integer,
        "input_tokens" integer,
        "output_tokens" integer,
        "cache_read_tokens" integer,
        "cache_creation_tokens" integer,
        "raw_output" jsonb,
        CONSTRAINT "ccs_status_check" CHECK ("status" IN ('running','complete','aborted','stopped'))
      );
    `);
    await ctx.db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_ccs_project" ON "claude_code_container_sessions" ("project_id");`);
    await ctx.db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_ccs_agent" ON "claude_code_container_sessions" ("agent_id");`);
    await ctx.db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_ccs_task" ON "claude_code_container_sessions" ("task_id");`);
    await ctx.db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_ccs_project_started" ON "claude_code_container_sessions" ("project_id", "started_at" DESC);`);

    // Pre-seed 'proj-a' so the FK on agents/sessions is satisfied for
    // cross-project assertions.
    await ctx.db.insert(projects).values({ id: 'proj-a', name: 'Project A' }).onConflictDoNothing();

    const config = makeConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(sessionsPlugin, { config });

    // Register two agents in 'default' so we have valid UUIDs to point at.
    const reg1 = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    agent1Id = reg1.json().id;

    const reg2 = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-2', worktree: '/tmp/wt2' },
    });
    agent2Id = reg2.json().id;

    // Create a task so taskId references a real row.
    const taskRows = await ctx.db
      .insert(tasks)
      .values({ projectId: 'default', title: 'test task' })
      .returning();
    taskId = taskRows[0].id;
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('POST /sessions inserts a running row and returns 201 + { id } (UUID)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id, taskId },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(typeof body.id === 'string');
    assert.match(body.id, UUID_RE);

    // Confirm row was actually inserted with the right shape
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
    });
    const rows = list.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, body.id);
    assert.equal(rows[0].agentId, agent1Id);
    assert.equal(rows[0].taskId, taskId);
    assert.equal(rows[0].status, 'running');
    assert.ok(rows[0].startedAt != null);
    assert.equal(rows[0].endedAt, null);
  });

  it('POST /sessions allows null taskId', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    assert.equal(res.statusCode, 201);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
    });
    const rows = list.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].taskId, null);
  });

  it('POST /sessions rejects an agentId that does not belong to the requesting project', async () => {
    // Insert agent into project 'proj-a'
    const regOther = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'proj-a' },
      payload: { name: 'agent-other', worktree: '/tmp/other' },
    });
    const otherAgentId = regOther.json().id;
    assert.match(otherAgentId, UUID_RE);

    // Try to use it from 'default'
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: otherAgentId },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400 or 404 got ${res.statusCode}`);
  });

  it('POST /sessions rejects a soft-deleted agent', async () => {
    // Soft-delete agent-1 directly via DB (route doesn't allow setting 'deleted').
    await ctx.db
      .update(agents)
      .set({ status: 'deleted' })
      .where(eq(agents.id, agent1Id));

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    assert.ok(
      res.statusCode === 400 || res.statusCode === 404,
      `expected 400/404 got ${res.statusCode}`,
    );
    assert.equal(res.json().error, 'invalid_agentId');
  });

  it('POST /sessions returns 404 when X-Project-Id is unknown', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'no-such-project' },
      payload: { agentId: agent1Id },
    });
    assert.equal(res.statusCode, 404);
  });

  it('PATCH /sessions/:id updates token counts, status, exitCode, endedAt, rawOutput; returns 200 with updated row', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id, taskId },
    });
    const sessionId = create.json().id;

    // endedAt must be >= the row's startedAt (which was stamped at POST).
    // Use "now" to be safely after startedAt and within future tolerance.
    const endedAt = new Date().toISOString();
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: {
        status: 'complete',
        exitCode: 0,
        endedAt,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        rawOutput: { type: 'result', usage: { input_tokens: 10 } },
      },
    });
    assert.equal(patchRes.statusCode, 200);
    const row = patchRes.json();
    assert.equal(row.id, sessionId);
    assert.equal(row.status, 'complete');
    assert.equal(row.exitCode, 0);
    assert.equal(row.inputTokens, 10);
    assert.equal(row.outputTokens, 20);
    assert.equal(row.cacheReadTokens, 30);
    assert.equal(row.cacheCreationTokens, 40);
    assert.deepEqual(row.rawOutput, { type: 'result', usage: { input_tokens: 10 } });
    assert.ok(row.endedAt != null);
  });

  it('PATCH /sessions/:id stamps endedAt server-side when terminal status is set without endedAt', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    const sessionId = create.json().id;

    const before = Date.now();
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'aborted', exitCode: 1 },
    });
    assert.equal(patchRes.statusCode, 200);
    const row = patchRes.json();
    assert.equal(row.status, 'aborted');
    assert.ok(row.endedAt != null);
    const stamped = new Date(row.endedAt).getTime();
    assert.ok(
      stamped >= before - 1000 && stamped <= Date.now() + 1000,
      `server-stamped endedAt out of expected range: ${row.endedAt}`,
    );
  });

  it('PATCH /sessions/:id re-stamps endedAt on terminal-to-terminal transition without endedAt', async () => {
    // Create the session via direct DB insert with a startedAt well in the
    // past so we can plant a non-current endedAt that is still after
    // startedAt — this lets us prove the server re-stamps to a current value.
    const sessionId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const plantedEndedAt = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
    await ctx.db.insert(claudeCodeContainerSessions).values({
      id: sessionId,
      projectId: 'default',
      agentId: agent1Id,
      taskId: null,
      status: 'complete',
      startedAt,
      endedAt: plantedEndedAt,
      exitCode: 0,
    });

    // Now flip to aborted without supplying endedAt — server must re-stamp.
    // The spec rule: terminal status + no endedAt body field => server stamps,
    // unconditional on whether the row already had an endedAt.
    const before = Date.now();
    const flipRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'aborted' },
    });
    assert.equal(flipRes.statusCode, 200);
    const row = flipRes.json();
    assert.equal(row.status, 'aborted');
    assert.ok(row.endedAt != null);
    const restamped = new Date(row.endedAt).getTime();
    const plantedMs = plantedEndedAt.getTime();
    // The re-stamp must be strictly later than the planted (3-minutes-ago)
    // stamp, proving the server re-set endedAt rather than leaving it.
    assert.ok(
      restamped > plantedMs,
      `expected re-stamped endedAt (${row.endedAt}) > planted (${plantedEndedAt.toISOString()})`,
    );
    assert.ok(
      restamped >= before - 1000 && restamped <= Date.now() + 1000,
      `server-stamped endedAt out of expected range: ${row.endedAt}`,
    );
  });

  it('PATCH /sessions/:id rejects rawOutput payloads that exceed the 64 KiB cap', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    const sessionId = create.json().id;

    // Build a > 64 KiB payload by stuffing a large string.
    const huge = 'x'.repeat(70 * 1024);
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { rawOutput: { blob: huge } },
    });
    assert.equal(patchRes.statusCode, 400);
    assert.equal(patchRes.json().error, 'rawOutput_too_large');
  });

  it('PATCH /sessions/:id rejects an endedAt more than 5s in the future', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    const sessionId = create.json().id;

    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'complete', endedAt: farFuture },
    });
    assert.equal(patchRes.statusCode, 400);
    assert.equal(patchRes.json().error, 'invalid_endedAt');
  });

  it('PATCH /sessions/:id rejects an endedAt earlier than startedAt', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    const sessionId = create.json().id;

    // Pick a clearly-prior timestamp (year 2000).
    const longBefore = '2000-01-01T00:00:00.000Z';
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'complete', endedAt: longBefore },
    });
    assert.equal(patchRes.statusCode, 400);
    assert.equal(patchRes.json().error, 'invalid_endedAt');
  });

  it('PATCH /sessions/:id returns 404 when the session does not exist or belongs to a different project', async () => {
    // Non-existent UUID
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res404 = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${fakeId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'complete' },
    });
    assert.equal(res404.statusCode, 404);

    // Session that exists but belongs to another project
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    const sessionId = create.json().id;

    const wrongProj = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'proj-a' },
      payload: { status: 'complete' },
    });
    assert.equal(wrongProj.statusCode, 404);
  });

  it('PATCH /sessions/:id rejects regression from terminal status back to running', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
      payload: { agentId: agent1Id },
    });
    const sessionId = create.json().id;

    // Move to complete
    const completeRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'complete', exitCode: 0 },
    });
    assert.equal(completeRes.statusCode, 200);

    // Now try to go back to running
    const regression = await ctx.app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}`,
      headers: { 'x-project-id': 'default' },
      payload: { status: 'running' },
    });
    assert.ok(
      regression.statusCode === 409 || regression.statusCode === 400,
      `expected 409 or 400 got ${regression.statusCode}`,
    );
  });

  it('GET /sessions returns rows ordered by startedAt DESC, filters by agentId/taskId/status/X-Project-Id, respects limits', async () => {
    // Insert sessions with distinct startedAt values via direct insert so we
    // control ordering precisely (the route inserts use new Date() at request time).
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const idC = crypto.randomUUID();
    const idOther = crypto.randomUUID();

    // Need an agent that exists in proj-a for the cross-project row.
    const regOther = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'proj-a' },
      payload: { name: 'agent-pa', worktree: '/tmp/pa' },
    });
    const projAAgentId = regOther.json().id;

    await ctx.db.insert(claudeCodeContainerSessions).values([
      {
        id: idA,
        projectId: 'default',
        agentId: agent1Id,
        taskId,
        status: 'running',
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: idB,
        projectId: 'default',
        agentId: agent2Id,
        taskId: null,
        status: 'complete',
        startedAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        id: idC,
        projectId: 'default',
        agentId: agent1Id,
        taskId: null,
        status: 'aborted',
        startedAt: new Date('2026-01-03T00:00:00Z'),
      },
      // Different project — must not show up under default
      {
        id: idOther,
        projectId: 'proj-a',
        agentId: projAAgentId,
        taskId: null,
        status: 'running',
        startedAt: new Date('2026-01-04T00:00:00Z'),
      },
    ]);

    // 1. project scoping: default sees 3 rows, not the proj-a row
    const allDefault = await ctx.app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(allDefault.statusCode, 200);
    const defaultRows = allDefault.json();
    assert.equal(defaultRows.length, 3);
    // Ordered DESC by startedAt: C, B, A
    assert.deepEqual(
      defaultRows.map((r: { id: string }) => r.id),
      [idC, idB, idA],
    );

    // 2. filter by agentId
    const byAgent = await ctx.app.inject({
      method: 'GET',
      url: `/sessions?agentId=${agent1Id}`,
      headers: { 'x-project-id': 'default' },
    });
    const byAgentRows = byAgent.json();
    assert.equal(byAgentRows.length, 2);
    assert.deepEqual(byAgentRows.map((r: { id: string }) => r.id), [idC, idA]);

    // 3. filter by taskId
    const byTask = await ctx.app.inject({
      method: 'GET',
      url: `/sessions?taskId=${taskId}`,
      headers: { 'x-project-id': 'default' },
    });
    const byTaskRows = byTask.json();
    assert.equal(byTaskRows.length, 1);
    assert.equal(byTaskRows[0].id, idA);

    // 4. filter by status
    const byStatus = await ctx.app.inject({
      method: 'GET',
      url: '/sessions?status=complete',
      headers: { 'x-project-id': 'default' },
    });
    const byStatusRows = byStatus.json();
    assert.equal(byStatusRows.length, 1);
    assert.equal(byStatusRows[0].id, idB);

    // 5. limit clamping: explicit limit applied
    const limited = await ctx.app.inject({
      method: 'GET',
      url: '/sessions?limit=2',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(limited.json().length, 2);

    // 6. limit max enforced (request 9999, get at most 500 — but only 3 exist, so 3)
    const huge = await ctx.app.inject({
      method: 'GET',
      url: '/sessions?limit=9999',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(huge.statusCode, 200);
    assert.equal(huge.json().length, 3);

    // 7. cross-project — proj-a sees only its row
    const projA = await ctx.app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { 'x-project-id': 'proj-a' },
    });
    const projARows = projA.json();
    assert.equal(projARows.length, 1);
    assert.equal(projARows[0].id, idOther);
  });
});
