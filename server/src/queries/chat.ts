import { eq, and, gt, lt, desc, asc, sql } from 'drizzle-orm';
import { chatMessages, roomMembers, agents } from '../schema/tables.js';
import type { DrizzleDb, DrizzleTx } from '../drizzle-instance.js';

/** Accept either a full DB instance or a transaction client. */
type DbOrTx = DrizzleDb | DrizzleTx;

export interface SendMessageOpts {
  roomId: string;
  authorType: 'agent' | 'operator' | 'system';
  authorAgentId: string | null;
  content: string;
  replyTo?: number | null;
}

export async function sendMessage(db: DbOrTx, opts: SendMessageOpts) {
  const rows = await db
    .insert(chatMessages)
    .values({
      roomId: opts.roomId,
      authorType: opts.authorType,
      authorAgentId: opts.authorAgentId,
      content: opts.content,
      replyTo: opts.replyTo ?? null,
    })
    .returning();
  return rows[0];
}

export interface GetHistoryOpts {
  before?: number;
  after?: number;
  limit?: number;
}

const senderColumn = sql`COALESCE(${agents.name}, CASE ${chatMessages.authorType} WHEN 'operator' THEN 'user' WHEN 'system' THEN 'system' END)`.as('sender');

const historySelect = {
  id: chatMessages.id,
  roomId: chatMessages.roomId,
  authorType: chatMessages.authorType,
  authorAgentId: chatMessages.authorAgentId,
  content: chatMessages.content,
  replyTo: chatMessages.replyTo,
  createdAt: chatMessages.createdAt,
  sender: senderColumn,
} as const;

export async function getHistory(db: DbOrTx, roomId: string, opts: GetHistoryOpts = {}) {
  const pageSize = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const baseQuery = db
    .select(historySelect)
    .from(chatMessages)
    .leftJoin(agents, eq(agents.id, chatMessages.authorAgentId));

  if (opts.after != null) {
    return baseQuery
      .where(and(eq(chatMessages.roomId, roomId), gt(chatMessages.id, opts.after)))
      .orderBy(asc(chatMessages.id))
      .limit(pageSize);
  }

  if (opts.before != null) {
    const rows = await baseQuery
      .where(and(eq(chatMessages.roomId, roomId), lt(chatMessages.id, opts.before)))
      .orderBy(desc(chatMessages.id))
      .limit(pageSize);
    rows.reverse();
    return rows;
  }

  const rows = await baseQuery
    .where(eq(chatMessages.roomId, roomId))
    .orderBy(desc(chatMessages.id))
    .limit(pageSize);
  rows.reverse();
  return rows;
}

export async function isAgentMember(db: DbOrTx, roomId: string, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)));
  return rows.length > 0;
}
