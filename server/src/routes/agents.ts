import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { getDb } from "../drizzle-instance.js";
import * as agentsQ from "../queries/agents.js";
import type { AgentPublicRow } from "../queries/agents.js";
import * as roomsQ from "../queries/rooms.js";
import * as filesQ from "../queries/files.js";
import * as tasksLifecycleQ from "../queries/tasks-lifecycle.js";
import type { ScaffoldConfig } from "../config.js";
import { mergeIntoBranch } from "../git-utils.js";
import {
  seedBranchFor,
  agentBranchFor,
  AGENT_NAME_RE,
} from "../branch-naming.js";
import { resolveProject } from "../resolve-project.js";

interface AgentsOpts {
  config: ScaffoldConfig;
}

/** HTTP-response shape for a single agent. */
export interface AgentResponse {
  id: string;
  name: string;
  worktree: string;
  planDoc: string | null;
  status: string;
  mode: string;
  registeredAt: string | Date | null;
  containerHost: string | null;
  projectId: string;
}

export function formatAgent(row: AgentPublicRow): AgentResponse {
  return {
    id: row.id,
    name: row.name,
    worktree: row.worktree,
    planDoc: row.planDoc ?? null,
    status: row.status,
    mode: row.mode,
    registeredAt: row.registeredAt ?? null,
    containerHost: row.containerHost ?? null,
    projectId: row.projectId ?? "default",
  };
}

/**
 * Statuses that can be set via POST /agents/:name/status.
 * Intentionally excludes 'deleted' — deletion goes through DELETE endpoints.
 */
const ALLOWED_STATUSES = [
  "idle",
  "working",
  "done",
  "error",
  "paused",
  "stopping",
] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];
const ALLOWED_STATUS_SET = new Set<string>(ALLOWED_STATUSES);

const agentsPlugin: FastifyPluginAsync<AgentsOpts> = async (fastify, opts) => {
  const { config } = opts;

  fastify.post<{
    Body: {
      name: string;
      worktree: string;
      planDoc?: string;
      mode?: "single" | "pump";
      containerHost?: string;
    };
  }>("/agents/register", async (request, reply) => {
    const { name, worktree, planDoc, mode, containerHost } = request.body;
    if (!AGENT_NAME_RE.test(name)) {
      return reply.badRequest("Invalid agent name format");
    }
    const projectId = request.projectId;
    const sessionToken = randomBytes(16).toString("hex");
    const db = getDb();

    const newAgent = await agentsQ.register(db, {
      name,
      worktree,
      planDoc: planDoc ?? null,
      mode: mode ?? "single",
      containerHost: containerHost ?? null,
      sessionToken,
      projectId,
    });

    const roomId = `${name}-direct`;
    const existingRoom = await roomsQ.getRoom(db, roomId);
    if (!existingRoom) {
      await roomsQ.createRoom(db, {
        id: roomId,
        name: `Direct: ${name}`,
        type: "direct",
        createdBy: name,
        projectId,
      });
      await roomsQ.addMember(db, roomId, newAgent.id);
    }

    return { ok: true, id: newAgent.id, sessionToken: newAgent.sessionToken };
  });

  fastify.get("/agents", async (request) => {
    const db = getDb();
    const rows = await agentsQ.getAll(db, request.projectId);
    return rows.map(formatAgent);
  });

  // GET /agents/:name -- fetch a single agent by name
  fastify.get<{
    Params: { name: string };
  }>("/agents/:name", async (request, reply) => {
    const db = getDb();
    const row = await agentsQ.getByName(
      db,
      request.projectId,
      request.params.name,
    );
    if (!row) {
      return reply.notFound(`Agent '${request.params.name}' not registered`);
    }
    return formatAgent(row);
  });

  fastify.post<{
    Params: { name: string };
    Body: { status: string };
  }>("/agents/:name/status", async (request, reply) => {
    const { name } = request.params;
    const { status } = request.body;
    const db = getDb();

    if (status === "deleted") {
      return reply.code(400).send({
        error: "invalid_status",
        allowed: ALLOWED_STATUSES,
      });
    }

    if (!ALLOWED_STATUS_SET.has(status)) {
      return reply.code(400).send({
        error: "invalid_status",
        allowed: ALLOWED_STATUSES,
      });
    }

    const agent = await agentsQ.getByName(db, request.projectId, name);
    if (!agent) {
      return reply.notFound(`Agent '${name}' not registered`);
    }
    await agentsQ.updateStatus(
      db,
      request.projectId,
      name,
      status as agentsQ.AgentStatus,
    );
    return { ok: true };
  });

  // DELETE /agents/:name -- soft-delete a single agent.
  // sessionToken is optional — omitting it allows operator-level deletion without a token.
  fastify.delete<{
    Params: { name: string };
    Querystring: { sessionToken?: string };
  }>("/agents/:name", async (request, reply) => {
    const { name } = request.params;
    const { sessionToken } = request.query;
    const db = getDb();
    const agent = await agentsQ.getByNameFull(db, request.projectId, name);
    if (!agent) {
      return reply.notFound(`Agent '${name}' not registered`);
    }

    if (sessionToken && agent.sessionToken !== sessionToken) {
      fastify.log.warn(
        { agent: name, projectId: request.projectId },
        "DELETE /agents/:name session token mismatch",
      );
      return reply.code(409).send({
        error:
          "session token mismatch — another container has taken over this agent slot",
      });
    }

    await db.transaction(async (tx) => {
      await agentsQ.softDelete(tx, request.projectId, name);
      await filesQ.releaseByClaimantAgentId(tx, request.projectId, agent.id);
      await tasksLifecycleQ.releaseByAgent(tx, request.projectId, agent.id);
    });
    return { ok: true, deleted: true };
  });

  // DELETE /agents -- soft-delete all agents for the project.
  // No sessionToken required — this is an operator-level bulk action.
  fastify.delete("/agents", async (request) => {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const count = await agentsQ.deleteAllForProject(tx, request.projectId);
      await filesQ.releaseAll(tx, request.projectId);
      await tasksLifecycleQ.releaseAllActive(tx, request.projectId);
      return count;
    });
    return { ok: true, deletedCount: result };
  });

  // POST /agents/:name/sync -- merge seed branch into agent's branch
  fastify.post<{ Params: { name: string } }>(
    "/agents/:name/sync",
    async (request, reply) => {
      const { name } = request.params;
      const db = getDb();

      const agent = await agentsQ.getWorktreeInfo(db, request.projectId, name);
      if (!agent) {
        return reply.notFound(`Agent '${name}' not found`);
      }

      let project;
      try {
        project = await resolveProject(config, db, agent.projectId);
      } catch {
        return reply.badRequest(`Unknown project: "${agent.projectId}"`);
      }
      const bareRepo = project.bareRepoPath;
      if (!bareRepo) {
        return reply.code(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: "sync requires bareRepoPath to be configured",
        });
      }

      const seedBranch = seedBranchFor(agent.projectId, project);
      const targetBranch = agentBranchFor(agent.projectId, name);

      const result = mergeIntoBranch(bareRepo, seedBranch, targetBranch);
      if (result.ok) {
        return reply.send({
          ok: true,
          ...(result.commitSha ? { commitSha: result.commitSha } : {}),
        });
      } else {
        return reply.code(409).send({ ok: false, reason: result.reason });
      }
    },
  );
};

export default agentsPlugin;
