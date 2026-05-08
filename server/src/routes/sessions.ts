import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, type DrizzleDb } from '../drizzle-instance.js';
import { claudeCodeContainerSessions } from '../schema/tables.js';
import * as agentsQ from '../queries/agents.js';
import type { ScaffoldConfig } from '../config.js';
import { resolveProject } from '../resolve-project.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionRow = typeof claudeCodeContainerSessions.$inferSelect;

const TERMINAL_STATUSES = new Set(['complete', 'aborted', 'stopped']);
const ALL_STATUSES = new Set(['running', 'complete', 'aborted', 'stopped']);

/** Maximum size of the JSON-serialised rawOutput payload, in bytes. The
 * expected payload is the Claude `result` event, which is well under this.
 */
const RAW_OUTPUT_MAX_BYTES = 64 * 1024;

/** Tolerance for clock skew between caller and server when validating
 * `endedAt`. Five seconds in the future is acceptable. */
const ENDED_AT_FUTURE_TOLERANCE_MS = 5_000;

export interface SessionResponse {
  id: string;
  projectId: string;
  agentId: string;
  taskId: number | null;
  status: string;
  startedAt: string | Date | null;
  endedAt: string | Date | null;
  exitCode: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  rawOutput: unknown;
}

/**
 * Resolve the project from the request, returning `true` on success. On
 * failure (unknown project), sends a 404 reply and returns `false`. Callers
 * MUST early-return when `false` is returned.
 */
async function ensureProject(
  config: ScaffoldConfig,
  db: DrizzleDb,
  projectId: string,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    await resolveProject(config, db, projectId);
    return true;
  } catch {
    void reply.notFound(`Unknown project: '${projectId}'`);
    return false;
  }
}

export function formatSession(row: SessionRow): SessionResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    taskId: row.taskId ?? null,
    status: row.status,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    exitCode: row.exitCode ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cacheReadTokens: row.cacheReadTokens ?? null,
    cacheCreationTokens: row.cacheCreationTokens ?? null,
    rawOutput: row.rawOutput ?? null,
  };
}

interface PluginOpts {
  config: ScaffoldConfig;
}

const sessionsPlugin: FastifyPluginAsync<PluginOpts> = async (
  fastify,
  { config },
) => {
  // POST /sessions — create a running session
  fastify.post<{
    Body: {
      agentId?: string;
      taskId?: number | null;
    };
  }>('/sessions', async (request, reply) => {
    const body = request.body ?? {};
    const agentId = body.agentId;
    const taskId =
      body.taskId === undefined || body.taskId === null ? null : body.taskId;

    if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
      return reply.code(400).send({ error: 'invalid_agentId' });
    }
    if (taskId !== null && (!Number.isInteger(taskId) || taskId < 1)) {
      return reply.code(400).send({ error: 'invalid_taskId' });
    }

    const db = getDb();
    const projectId = request.projectId;

    if (!(await ensureProject(config, db, projectId, reply))) return;

    const agent = await agentsQ.getByIdInProject(db, projectId, agentId);
    if (!agent) {
      return reply.code(400).send({ error: 'invalid_agentId' });
    }
    if (agent.status === 'deleted') {
      return reply.code(400).send({ error: 'invalid_agentId' });
    }

    const id = randomUUID();
    await db.insert(claudeCodeContainerSessions).values({
      id,
      projectId,
      agentId,
      taskId,
      status: 'running',
      startedAt: new Date(),
    });

    return reply.code(201).send({ id });
  });

  // PATCH /sessions/:id — update token counts, status, exit code, endedAt, rawOutput
  fastify.patch<{
    Params: { id: string };
    Body: {
      status?: string;
      exitCode?: number;
      endedAt?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      rawOutput?: Record<string, unknown>;
    };
  }>('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }

    const db = getDb();
    const projectId = request.projectId;

    if (!(await ensureProject(config, db, projectId, reply))) return;

    const existing = await db
      .select()
      .from(claudeCodeContainerSessions)
      .where(
        and(
          eq(claudeCodeContainerSessions.id, id),
          eq(claudeCodeContainerSessions.projectId, projectId),
        ),
      );
    const current = existing[0];
    if (!current) {
      return reply.notFound(`Session '${id}' not found`);
    }

    const body = request.body ?? {};
    const update: Partial<typeof claudeCodeContainerSessions.$inferInsert> = {};

    if (body.status !== undefined) {
      if (!ALL_STATUSES.has(body.status)) {
        return reply.code(400).send({ error: 'invalid_status' });
      }
      // Reject regression from terminal status back to running
      if (
        TERMINAL_STATUSES.has(current.status) &&
        body.status === 'running'
      ) {
        return reply.code(409).send({ error: 'terminal_status_regression' });
      }
      update.status = body.status;
    }

    if (body.exitCode !== undefined) {
      if (!Number.isInteger(body.exitCode)) {
        return reply.code(400).send({ error: 'invalid_exitCode' });
      }
      update.exitCode = body.exitCode;
    }

    if (body.endedAt !== undefined) {
      const parsed = new Date(body.endedAt);
      if (Number.isNaN(parsed.getTime())) {
        return reply.code(400).send({ error: 'invalid_endedAt' });
      }
      // Reject endedAt more than 5 seconds in the future (clock-skew tolerance).
      if (parsed.getTime() > Date.now() + ENDED_AT_FUTURE_TOLERANCE_MS) {
        return reply.code(400).send({ error: 'invalid_endedAt' });
      }
      // Reject endedAt earlier than the row's startedAt.
      if (current.startedAt && parsed < current.startedAt) {
        return reply.code(400).send({ error: 'invalid_endedAt' });
      }
      update.endedAt = parsed;
    }

    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
    ] as const) {
      const v = body[key];
      if (v !== undefined) {
        if (!Number.isInteger(v) || v < 0) {
          return reply.code(400).send({ error: `invalid_${key}` });
        }
        update[key] = v;
      }
    }

    if (body.rawOutput !== undefined) {
      // Bound the rawOutput payload size to prevent unbounded jsonb growth.
      const serialised = JSON.stringify(body.rawOutput);
      if (serialised.length > RAW_OUTPUT_MAX_BYTES) {
        return reply.code(400).send({ error: 'rawOutput_too_large' });
      }
      update.rawOutput = body.rawOutput;
    }

    // If the resulting status is terminal and endedAt was not supplied,
    // server-stamp endedAt = now. Container clocks are not trusted as the
    // authoritative finalize time. This stamp is unconditional on the
    // existing endedAt value: a terminal-to-terminal re-patch (e.g.
    // complete -> aborted) without an explicit endedAt re-stamps the time.
    if (
      body.status !== undefined &&
      TERMINAL_STATUSES.has(body.status) &&
      body.endedAt === undefined
    ) {
      update.endedAt = new Date();
    }

    if (Object.keys(update).length === 0) {
      return formatSession(current);
    }

    const updatedRows = await db
      .update(claudeCodeContainerSessions)
      .set(update)
      .where(
        and(
          eq(claudeCodeContainerSessions.id, id),
          eq(claudeCodeContainerSessions.projectId, projectId),
        ),
      )
      .returning();

    const updated = updatedRows[0];
    if (!updated) {
      // Should not happen — we just verified existence.
      return reply.notFound(`Session '${id}' not found`);
    }
    return formatSession(updated);
  });

  // GET /sessions — list sessions for the requesting project, with optional filters
  fastify.get<{
    Querystring: {
      agentId?: string;
      taskId?: string;
      status?: string;
      limit?: string;
    };
  }>('/sessions', async (request, reply) => {
    const { agentId, taskId, status, limit } = request.query;
    const projectId = request.projectId;
    const db = getDb();

    if (!(await ensureProject(config, db, projectId, reply))) return;

    const conditions = [
      eq(claudeCodeContainerSessions.projectId, projectId),
    ];

    if (agentId !== undefined) {
      if (!UUID_RE.test(agentId)) {
        return reply.code(400).send({ error: 'invalid_agentId' });
      }
      conditions.push(eq(claudeCodeContainerSessions.agentId, agentId));
    }

    if (taskId !== undefined) {
      const parsed = Number(taskId);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return reply.code(400).send({ error: 'invalid_taskId' });
      }
      conditions.push(eq(claudeCodeContainerSessions.taskId, parsed));
    }

    if (status !== undefined) {
      if (!ALL_STATUSES.has(status)) {
        return reply.code(400).send({ error: 'invalid_status' });
      }
      conditions.push(eq(claudeCodeContainerSessions.status, status));
    }

    const limitNum = Number(limit);
    const limitVal = Math.max(
      1,
      Math.min(Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 100, 500),
    );

    const rows = await db
      .select()
      .from(claudeCodeContainerSessions)
      .where(and(...conditions))
      .orderBy(desc(claudeCodeContainerSessions.startedAt))
      .limit(limitVal);

    return rows.map(formatSession);
  });
};

export default sessionsPlugin;
