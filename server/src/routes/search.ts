import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as searchQ from '../queries/search.js';

function formatTaskRow(row: any) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.sourcePath,
    acceptanceCriteria: row.acceptanceCriteria,
    status: row.status,
    priority: row.priority,
    files: [],
    dependsOn: [],
    blockedBy: [],
    blockReasons: [],
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    result: row.result ?? null,
    completedBy: (() => {
      if (!row.result) return null;
      try {
        const parsed = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        return parsed?.agent ?? null;
      } catch { return null; }
    })(),
    progressLog: row.progressLog,
    createdAt: row.createdAt,
    projectId: row.projectId,
  };
}

function formatMessageRow(row: any) {
  let payload: unknown = row.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* keep as string */ }
  }

  let result: unknown = null;
  if (row.result) {
    if (typeof row.result === 'string') {
      try { result = JSON.parse(row.result); } catch { result = row.result; }
    } else {
      result = row.result;
    }
  }

  return {
    id: row.id,
    fromAgent: row.fromAgent,
    channel: row.channel,
    type: row.type,
    payload,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    resolvedAt: row.resolvedAt,
    result,
    createdAt: row.createdAt,
  };
}

function formatAgentRow(row: any) {
  return {
    name: row.name,
    worktree: row.worktree,
    planDoc: row.planDoc,
    status: row.status,
    mode: row.mode,
    registeredAt: row.registeredAt,
    containerHost: row.containerHost,
    projectId: row.projectId,
  };
}

const searchPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { q?: string; limit?: string };
  }>('/search', async (request, reply) => {
    const { q, limit } = request.query;

    if (!q || q.length < 2) {
      return reply.badRequest('q must be at least 2 characters');
    }

    const limitNum = limit ? Number(limit) : 20;
    const db = getDb();

    const taskRows = await searchQ.searchTasks(db, q, { limit: limitNum });
    const messageRows = await searchQ.searchMessages(db, q, { limit: limitNum });
    const agentRows = await searchQ.searchAgents(db, q, { limit: limitNum });

    return {
      tasks: taskRows.map(formatTaskRow),
      messages: messageRows.map(formatMessageRow),
      agents: agentRows.map(formatAgentRow),
    };
  });
};

export default searchPlugin;
