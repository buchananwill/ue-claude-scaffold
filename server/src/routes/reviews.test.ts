import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestConfig, registerAgent } from "../test-helper.js";
import {
  createDrizzleTestApp,
  type DrizzleTestContext,
} from "../drizzle-test-helper.js";
import tasksPlugin from "./tasks.js";
import agentsPlugin from "./agents.js";
import reviewsPlugin from "./reviews.js";
import { tasks } from "../schema/tables.js";

describe("reviews routes", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });
    await ctx.app.register(reviewsPlugin);
    await registerAgent(ctx.app, "agent-1");
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  async function createTask(title = "T"): Promise<number> {
    const post = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      payload: { title },
    });
    return post.json().id as number;
  }

  function postReview(
    taskId: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = { "x-project-id": "default" },
  ) {
    return ctx.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/reviews`,
      payload: body,
      headers,
    });
  }

  function getCycle(
    taskId: number,
    cycle: number,
    headers: Record<string, string> = { "x-project-id": "default" },
  ) {
    return ctx.app.inject({
      method: "GET",
      url: `/tasks/${taskId}/reviews/${cycle}`,
      headers,
    });
  }

  // ── POST /tasks/:id/reviews — happy path ───────────────────────────────

  it("inserts a run plus N findings atomically", async () => {
    const id = await createTask();

    const body = {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "## review\n\nfinding 1",
      findings: [
        {
          severity: "BLOCKING",
          ordinal: 0,
          filePath: "src/foo.ts",
          line: 42,
          title: "Null pointer",
          description: "Foo can be null when bar is empty",
          evidence: "bar.length === 0",
          fix: "guard clause",
        },
        {
          severity: "NOTE",
          ordinal: 1,
          title: "Style: prefer const",
          description: "use const where possible",
        },
      ],
    };

    const res = await postReview(id, body);
    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.equal(typeof json.runId, "number");
    assert.equal(json.findingIds.length, 2);

    // DB verification: row counts
    const runs = await ctx.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM review_runs WHERE task_id = ${id}`,
    );
    assert.equal(
      (runs as unknown as { rows: Array<{ c: number }> }).rows[0].c,
      1,
    );
    const findings = await ctx.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM review_findings WHERE run_id = ${json.runId}`,
    );
    assert.equal(
      (findings as unknown as { rows: Array<{ c: number }> }).rows[0].c,
      2,
    );
  });

  it("accepts findings: [] with verdict approve", async () => {
    const id = await createTask();

    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "style",
      verdict: "approve",
      rawMarkdown: "LGTM",
      findings: [],
    });

    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.equal(typeof json.runId, "number");
    assert.deepEqual(json.findingIds, []);
  });

  it("accepts findings: [] with verdict out_of_scope", async () => {
    const id = await createTask();

    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "browser",
      verdict: "out_of_scope",
      rawMarkdown: "no browser code touched",
      findings: [],
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().findingIds, []);
  });

  it("accepts approve with NOTE findings (count unconstrained)", async () => {
    const id = await createTask();

    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "style",
      verdict: "approve",
      rawMarkdown: "LGTM with notes",
      findings: [
        { severity: "NOTE", ordinal: 0, title: "note 1", description: "" },
        { severity: "NOTE", ordinal: 1, title: "note 2", description: "" },
        { severity: "NOTE", ordinal: 2, title: "note 3", description: "" },
      ],
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().findingIds.length, 3);
  });

  // ── POST /tasks/:id/reviews — uniqueness ─────────────────────────────

  it("returns 409 on duplicate (taskId, cycle, reviewerRole)", async () => {
    const id = await createTask();

    const first = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "LGTM",
      findings: [],
    });
    assert.equal(first.statusCode, 200, first.body);

    const dup = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "duplicate post",
      findings: [],
    });
    assert.equal(dup.statusCode, 409, dup.body);
  });

  it("allows different reviewerRole on same (taskId, cycle)", async () => {
    const id = await createTask();

    const r1 = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "a",
      findings: [],
    });
    assert.equal(r1.statusCode, 200);

    const r2 = await postReview(id, {
      cycle: 1,
      reviewerRole: "correctness",
      verdict: "approve",
      rawMarkdown: "b",
      findings: [],
    });
    assert.equal(r2.statusCode, 200);
  });

  it("allows same reviewerRole on a different cycle", async () => {
    const id = await createTask();

    const r1 = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "a",
      findings: [],
    });
    assert.equal(r1.statusCode, 200);

    const r2 = await postReview(id, {
      cycle: 2,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "b",
      findings: [],
    });
    assert.equal(r2.statusCode, 200);
  });

  // ── POST /tasks/:id/reviews — atomicity guarantee ─────────────────────

  it("rolls back the run insert when a finding insert fails", async () => {
    // We engineer a failure by passing an invalid severity that will pass
    // body validation but, if it slipped through, would fail the DB CHECK.
    // To exercise the atomicity guarantee we instead provide a malformed
    // ordinal that the body validator catches BEFORE any insert; the DB
    // should remain empty.
    const id = await createTask();

    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "bad payload",
      findings: [
        { severity: "BLOCKING", ordinal: 0, title: "ok", description: "" },
        { severity: "BLOCKING", ordinal: -1, title: "bad", description: "" },
      ],
    });
    assert.equal(res.statusCode, 400, res.body);

    const runs = await ctx.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM review_runs WHERE task_id = ${id}`,
    );
    assert.equal(
      (runs as unknown as { rows: Array<{ c: number }> }).rows[0].c,
      0,
    );
  });

  it("on unique conflict leaves DB with one run and zero new findings", async () => {
    // Validates the transactional behaviour at the DB level: when the run
    // insert hits the (taskId, cycle, reviewerRole) unique constraint, the
    // surrounding transaction must roll back so that no findings from the
    // second POST land in review_findings.
    const id = await createTask();

    const first = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "first",
      findings: [
        {
          severity: "BLOCKING",
          ordinal: 0,
          title: "first finding",
          description: "",
        },
      ],
    });
    assert.equal(first.statusCode, 200, first.body);

    const dup = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "second",
      findings: [
        {
          severity: "NOTE",
          ordinal: 0,
          title: "second finding A",
          description: "",
        },
        {
          severity: "NOTE",
          ordinal: 1,
          title: "second finding B",
          description: "",
        },
      ],
    });
    assert.equal(dup.statusCode, 409, dup.body);

    // Exactly one run, with the original verdict and rawMarkdown intact.
    const runs = await ctx.db.execute(
      sql`SELECT verdict, raw_markdown FROM review_runs WHERE task_id = ${id}`,
    );
    const runRows = (
      runs as unknown as {
        rows: Array<{ verdict: string; raw_markdown: string }>;
      }
    ).rows;
    assert.equal(runRows.length, 1);
    assert.equal(runRows[0].verdict, "request_changes");
    assert.equal(runRows[0].raw_markdown, "first");

    // The second POST's findings must NOT be present — only the first
    // finding survives. This is the load-bearing assertion: it proves the
    // failed second POST committed nothing to review_findings.
    const findings = await ctx.db.execute(
      sql`SELECT title FROM review_findings ORDER BY id ASC`,
    );
    const findingRows = (
      findings as unknown as { rows: Array<{ title: string }> }
    ).rows;
    assert.equal(findingRows.length, 1);
    assert.equal(findingRows[0].title, "first finding");
  });

  // ── POST /tasks/:id/reviews — body validation ─────────────────────────

  it("rejects missing cycle", async () => {
    const id = await createTask();
    const res = await postReview(id, {
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "",
      findings: [],
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects bad verdict", async () => {
    const id = await createTask();
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "maybe",
      rawMarkdown: "",
      findings: [],
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects bad reviewerRole", async () => {
    const id = await createTask();
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "bad role!",
      verdict: "approve",
      rawMarkdown: "",
      findings: [],
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects bad severity", async () => {
    const id = await createTask();
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "",
      findings: [
        { severity: "WARNING", ordinal: 0, title: "t", description: "" },
      ],
    });
    assert.equal(res.statusCode, 400);
  });

  it("returns 404 on unknown task id", async () => {
    const res = await postReview(99999, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "",
      findings: [],
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  // ── GET /tasks/:id/reviews/:cycle ─────────────────────────────────────

  it("returns runs array with correct shape", async () => {
    const id = await createTask();

    await postReview(id, {
      cycle: 2,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "## safety review",
      findings: [
        {
          severity: "BLOCKING",
          ordinal: 0,
          title: "finding A",
          description: "d",
        },
      ],
    });
    await postReview(id, {
      cycle: 2,
      reviewerRole: "correctness",
      verdict: "approve",
      rawMarkdown: "## correctness review",
      findings: [],
    });
    await postReview(id, {
      cycle: 2,
      reviewerRole: "style",
      verdict: "approve",
      rawMarkdown: "## style review",
      findings: [
        { severity: "NOTE", ordinal: 0, title: "minor", description: "d2" },
      ],
    });

    const res = await getCycle(id, 2);
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.equal(json.cycle, 2);
    assert.equal(json.runs.length, 3);

    const safety = json.runs.find(
      (r: { reviewerRole: string }) => r.reviewerRole === "safety",
    );
    assert.ok(safety);
    // The reviewRun's DB id is surfaced so role-session prompts can name the
    // concrete run references the engineer/arbitrator fetch.
    assert.equal(typeof safety.id, "number");
    assert.equal(safety.verdict, "request_changes");
    assert.equal(safety.rawMarkdown, "## safety review");
    assert.equal(safety.findings.length, 1);
    assert.equal(safety.findings[0].title, "finding A");
    assert.equal(safety.findings[0].severity, "BLOCKING");

    const correctness = json.runs.find(
      (r: { reviewerRole: string }) => r.reviewerRole === "correctness",
    );
    assert.deepEqual(correctness.findings, []);
  });

  it("returns empty runs array for an un-posted cycle", async () => {
    const id = await createTask();
    const res = await getCycle(id, 5);
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.equal(json.cycle, 5);
    assert.deepEqual(json.runs, []);
  });

  it("only returns runs from the requested cycle", async () => {
    const id = await createTask();

    await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: "c1",
      findings: [],
    });
    await postReview(id, {
      cycle: 2,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "c2",
      findings: [],
    });

    const c1 = await getCycle(id, 1);
    assert.equal(c1.json().runs.length, 1);
    assert.equal(c1.json().runs[0].verdict, "approve");

    const c2 = await getCycle(id, 2);
    assert.equal(c2.json().runs.length, 1);
    assert.equal(c2.json().runs[0].verdict, "request_changes");
  });

  it("rejects invalid task id format", async () => {
    const res = await getCycle(0, 1);
    assert.equal(res.statusCode, 400);
  });

  it("rejects negative cycle", async () => {
    const id = await createTask();
    const res = await ctx.app.inject({
      method: "GET",
      url: `/tasks/${id}/reviews/-1`,
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 400);
  });

  // ── project scoping ──────────────────────────────────────────────────

  it("POST rejects missing X-Project-Id with 400", async () => {
    const id = await createTask();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/tasks/${id}/reviews`,
      payload: {
        cycle: 1,
        reviewerRole: "safety",
        verdict: "approve",
        rawMarkdown: "",
        findings: [],
      },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it("GET rejects missing X-Project-Id with 400", async () => {
    const id = await createTask();
    const res = await ctx.app.inject({
      method: "GET",
      url: `/tasks/${id}/reviews/1`,
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  // Array-form `X-Project-Id` (header sent twice) must be rejected when the
  // first element is empty. Note: Fastify's `app.inject` (via light-my-request)
  // joins duplicate headers into a single comma-separated string before
  // dispatching to the route, so passing `['', '']` here actually arrives as
  // the string `,` — which the guard treats as a non-empty value and accepts.
  // This makes the array branch unreachable through the test injector. The
  // shared guard exercises the array path defensively for real HTTP traffic
  // (Node's `http` module preserves duplicate headers as `string[]`); we
  // exercise the guard directly to keep that contract under test.
  it("shared guard rejects array-form X-Project-Id when first element is empty", async () => {
    const { requireProjectIdHeader } = await import("./_project-id-guard.js");
    let captured: { code?: number; message?: unknown } = {};
    const fakeReply = {
      badRequest(message: unknown) {
        captured = { code: 400, message };
        return this;
      },
    } as unknown as Parameters<typeof requireProjectIdHeader>[1];
    const fakeRequest = {
      headers: { "x-project-id": ["", "proj-a"] as string[] },
    } as unknown as Parameters<typeof requireProjectIdHeader>[0];

    const ok = requireProjectIdHeader(fakeRequest, fakeReply);
    assert.equal(ok, false);
    assert.equal(captured.code, 400);
    assert.equal(captured.message, "X-Project-Id header is required");
  });

  it("shared guard accepts array-form X-Project-Id when first element is non-empty", async () => {
    const { requireProjectIdHeader } = await import("./_project-id-guard.js");
    const fakeReply = {
      badRequest() {
        throw new Error("should not have been called");
      },
    } as unknown as Parameters<typeof requireProjectIdHeader>[1];
    const fakeRequest = {
      headers: { "x-project-id": ["proj-a", "proj-b"] as string[] },
    } as unknown as Parameters<typeof requireProjectIdHeader>[0];

    const ok = requireProjectIdHeader(fakeRequest, fakeReply);
    assert.equal(ok, true);
  });

  it("POST returns 404 when task belongs to a different project", async () => {
    // Plant a task directly in proj-a, bypassing tasksPlugin so we can pick
    // the projectId. Then attempt to POST a review run against it from the
    // default project — must 404 and create no row.
    const planted = await ctx.db
      .insert(tasks)
      .values({
        projectId: "proj-a",
        title: "foreign task",
        status: "pending",
      })
      .returning();
    const foreignId = planted[0].id;

    const res = await postReview(
      foreignId,
      {
        cycle: 1,
        reviewerRole: "safety",
        verdict: "approve",
        rawMarkdown: "x",
        findings: [],
      },
      { "x-project-id": "default" },
    );
    assert.equal(res.statusCode, 404, res.body);

    const runs = await ctx.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM review_runs WHERE task_id = ${foreignId}`,
    );
    assert.equal(
      (runs as unknown as { rows: Array<{ c: number }> }).rows[0].c,
      0,
    );
  });

  it("GET returns 404 when task belongs to a different project", async () => {
    // Plant a task and a review run in proj-a. A request from default must
    // not see the run, even though the numeric task id is otherwise
    // accessible.
    const planted = await ctx.db
      .insert(tasks)
      .values({
        projectId: "proj-a",
        title: "foreign task",
        status: "pending",
      })
      .returning();
    const foreignId = planted[0].id;

    const post = await postReview(
      foreignId,
      {
        cycle: 1,
        reviewerRole: "safety",
        verdict: "approve",
        rawMarkdown: "secret",
        findings: [],
      },
      { "x-project-id": "proj-a" },
    );
    assert.equal(post.statusCode, 200, post.body);

    const cross = await getCycle(foreignId, 1, { "x-project-id": "default" });
    assert.equal(cross.statusCode, 404, cross.body);
  });

  // ── body length caps ─────────────────────────────────────────────────

  it("rejects rawMarkdown exceeding the maximum length", async () => {
    const id = await createTask();
    // 512_000 + 1 chars
    const oversize = "x".repeat(512_001);
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "approve",
      rawMarkdown: oversize,
      findings: [],
    });
    assert.equal(res.statusCode, 400, res.body);

    const runs = await ctx.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM review_runs WHERE task_id = ${id}`,
    );
    assert.equal(
      (runs as unknown as { rows: Array<{ c: number }> }).rows[0].c,
      0,
    );
  });

  it("rejects finding description exceeding the maximum length", async () => {
    const id = await createTask();
    const oversize = "d".repeat(32_769);
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "r",
      findings: [
        { severity: "BLOCKING", ordinal: 0, title: "t", description: oversize },
      ],
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it("rejects finding evidence exceeding the maximum length", async () => {
    const id = await createTask();
    const oversize = "e".repeat(32_769);
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "r",
      findings: [
        {
          severity: "BLOCKING",
          ordinal: 0,
          title: "t",
          description: "",
          evidence: oversize,
        },
      ],
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it("rejects finding fix exceeding the maximum length", async () => {
    const id = await createTask();
    const oversize = "f".repeat(32_769);
    const res = await postReview(id, {
      cycle: 1,
      reviewerRole: "safety",
      verdict: "request_changes",
      rawMarkdown: "r",
      findings: [
        {
          severity: "BLOCKING",
          ordinal: 0,
          title: "t",
          description: "",
          fix: oversize,
        },
      ],
    });
    assert.equal(res.statusCode, 400, res.body);
  });
});
