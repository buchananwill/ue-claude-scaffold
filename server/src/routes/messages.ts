import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

export interface MessageRow {
  id: number;
  from_agent: string;
  channel: string;
  type: string;
  payload: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  result: string | null;
  created_at: string;
}

export function formatMessage(row: MessageRow) {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }

  let result: unknown = null;
  if (row.result) {
    try {
      result = JSON.parse(row.result);
    } catch {
      result = row.result;
    }
  }

  return {
    id: row.id,
    fromAgent: row.from_agent,
    channel: row.channel,
    type: row.type,
    payload,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    resolvedAt: row.resolved_at,
    result,
    createdAt: row.created_at,
  };
}

const messagesPlugin: FastifyPluginAsync = async (fastify) => {
  const insertMessage = db.prepare(
    `INSERT INTO messages (from_agent, channel, type, payload)
     VALUES (@fromAgent, @channel, @type, @payload)`
  );

  const claimMessage = db.prepare(
    `UPDATE messages SET claimed_by = @claimedBy, claimed_at = CURRENT_TIMESTAMP
     WHERE id = @id AND claimed_by IS NULL`
  );

  const resolveMessage = db.prepare(
    `UPDATE messages SET resolved_at = CURRENT_TIMESTAMP, result = @result
     WHERE id = @id`
  );

  const deleteMessageById = db.prepare('DELETE FROM messages WHERE id = @id');
  const deleteMessagesByChannel = db.prepare('DELETE FROM messages WHERE channel = @channel');
  const deleteMessagesByChannelBefore = db.prepare('DELETE FROM messages WHERE channel = @channel AND id < @before');

  fastify.post<{
    Body: { channel: string; type: string; payload: unknown };
  }>('/messages', async (request) => {
    const agent = request.headers['x-agent-name'] as string | undefined;
    const { channel, type, payload } = request.body;
    const result = insertMessage.run({
      fromAgent: agent ?? 'unknown',
      channel,
      type,
      payload: JSON.stringify(payload),
    });
    return { id: Number(result.lastInsertRowid), ok: true };
  });

  fastify.get<{
    Params: { channel: string };
    Querystring: { type?: string };
  }>('/messages/:channel/count', async (request) => {
    const { channel } = request.params;
    const { type } = request.query;

    let sql = 'SELECT COUNT(*) as count FROM messages WHERE channel = ?';
    const params: unknown[] = [channel];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    const row = db.prepare(sql).get(...params) as { count: number };
    return { count: row.count };
  });

  fastify.get<{
    Params: { channel: string };
    Querystring: { since?: string; before?: string; type?: string; limit?: string };
  }>('/messages/:channel', async (request) => {
    const { channel } = request.params;
    const { since, before, type, limit } = request.query;
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);

    let sql = 'SELECT * FROM messages WHERE channel = ?';
    const params: unknown[] = [channel];

    if (since) {
      // Polling path: return all messages after cursor, no limit
      sql += ' AND id > ?';
      params.push(Number(since));
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      sql += ' ORDER BY id ASC';
      const rows = db.prepare(sql).all(...params) as MessageRow[];
      return rows.map(formatMessage);
    }

    if (before) {
      sql += ' AND id < ?';
      params.push(Number(before));
    }

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(pageSize);

    const rows = db.prepare(sql).all(...params) as MessageRow[];
    rows.reverse();
    return rows.map(formatMessage);
  });

  fastify.post<{
    Params: { id: string };
  }>('/messages/:id/claim', async (request, reply) => {
    const id = Number(request.params.id);
    const agent = request.headers['x-agent-name'] as string | undefined;

    const result = db.transaction(() => {
      const info = claimMessage.run({ id, claimedBy: agent ?? 'unknown' });
      return info.changes > 0;
    })();

    if (result) {
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
    resolveMessage.run({ id, result: JSON.stringify(result) });
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

    if (isId) {
      const info = deleteMessageById.run({ id: asNum });
      if (info.changes === 0) {
        return reply.notFound('message not found');
      }
      return { ok: true };
    }

    const channel = param;
    const { before } = request.query;

    if (before) {
      const info = deleteMessagesByChannelBefore.run({ channel, before: Number(before) });
      return { ok: true, deleted: info.changes };
    }

    const info = deleteMessagesByChannel.run({ channel });
    return { ok: true, deleted: info.changes };
  });
};

export default messagesPlugin;
