import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as msgQ from '../queries/messages.js';

export interface MessageRow {
  id: number;
  fromAgent: string;
  channel: string;
  type: string;
  payload: unknown;
  claimedBy: string | null;
  claimedAt: string | Date | null;
  resolvedAt: string | Date | null;
  result: unknown;
  createdAt: string | Date | null;
}

export function formatMessage(row: MessageRow) {
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

const messagesPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: { channel: string; type: string; payload: unknown };
  }>('/messages', async (request) => {
    const agent = request.headers['x-agent-name'] as string | undefined;
    const { channel, type, payload } = request.body;
    const db = getDb();
    const id = await msgQ.insert(db, {
      fromAgent: agent ?? 'unknown',
      channel,
      type,
      payload,
    });
    return { id, ok: true };
  });

  fastify.get<{
    Params: { channel: string };
    Querystring: { type?: string; from_agent?: string };
  }>('/messages/:channel/count', async (request) => {
    const { channel } = request.params;
    const { type, from_agent } = request.query;
    const isAll = channel === '_all';
    const db = getDb();

    const cnt = await msgQ.count(db, {
      channel: isAll ? undefined : channel,
      type: type || undefined,
      fromAgent: from_agent || undefined,
    });
    return { count: cnt };
  });

  fastify.get<{
    Params: { channel: string };
    Querystring: { since?: string; before?: string; type?: string; limit?: string; from_agent?: string };
  }>('/messages/:channel', async (request) => {
    const { channel } = request.params;
    const { since, before, type, limit, from_agent } = request.query;
    const isAll = channel === '_all';
    const db = getDb();

    const rows = await msgQ.list(db, {
      channel: isAll ? undefined : channel,
      since: since ? Number(since) : undefined,
      before: before ? Number(before) : undefined,
      type: type || undefined,
      fromAgent: from_agent || undefined,
      limit: limit ? Number(limit) : undefined,
    });

    return rows.map((r) => formatMessage(r as unknown as MessageRow));
  });

  fastify.post<{
    Params: { id: string };
  }>('/messages/:id/claim', async (request, reply) => {
    const id = Number(request.params.id);
    const agent = request.headers['x-agent-name'] as string | undefined;
    const db = getDb();

    const claimed = await msgQ.claim(db, id, agent ?? 'unknown');
    if (claimed) {
      return { ok: true };
    }
    return reply.conflict('already_claimed');
  });

  fastify.post<{
    Params: { id: string };
    Body: { result: unknown };
  }>('/messages/:id/resolve', async (request) => {
    const id = Number(request.params.id);
    const { result } = request.body;
    const db = getDb();
    await msgQ.resolve(db, id, result);
    return { ok: true };
  });

  // DELETE /messages/:param — disambiguates by param format:
  // numeric positive integer => delete single message by ID
  // non-numeric string => purge messages by channel name (with optional ?before=<id>)
  fastify.delete<{
    Params: { param: string };
    Querystring: { before?: string };
  }>('/messages/:param', async (request, reply) => {
    const { param } = request.params;
    const asNum = Number(param);
    const isId = Number.isInteger(asNum) && asNum > 0;
    const db = getDb();

    if (isId) {
      const deleted = await msgQ.deleteById(db, asNum);
      if (!deleted) {
        return reply.notFound('message not found');
      }
      return { ok: true };
    }

    const channel = param;
    const { before } = request.query;

    if (before) {
      const count = await msgQ.deleteByChannelBefore(db, channel, Number(before));
      return { ok: true, deleted: count };
    }

    const count = await msgQ.deleteByChannel(db, channel);
    return { ok: true, deleted: count };
  });
};

export default messagesPlugin;
