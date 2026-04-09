import { eq, and, gt, lt, desc, asc, sql } from 'drizzle-orm';
import { chatMessages, roomMembers, agents } from '../schema/tables.js';
import type { DbOrTx } from '../drizzle-instance.js';

const VALID_AUTHOR_TYPES = ['agent', 'operator', 'system'] as const;
type AuthorType = (typeof VALID_AUTHOR_TYPES)[number];

// TODO: extract to shared query helpers
function firstOrThrow<T>(rows: T[]): T {
  if (rows.length === 0) throw new Error('Insert returned no rows');
  return rows[0];
}

export interface SendMessageOpts {
  roomId: string;
  authorType: AuthorType;
  authorAgentId: string | null;
  content: string;
  replyTo?: number | null;
}

export async function sendMessage(db: DbOrTx, opts: SendMessageOpts): Promise<{
  id: number;
  roomId: string;
  authorType: string;
  authorAgentId: string | null;
  content: string;
  replyTo: number | null;
  createdAt: Date | null;
}> {
  if (!VALID_AUTHOR_TYPES.includes(opts.authorType)) {
    throw new Error(`Invalid authorType: ${opts.authorType}`);
  }

  if (opts.authorType === 'agent' && opts.authorAgentId == null) {
    throw new Error("authorAgentId is required when authorType is 'agent'");
  }
  if (opts.authorType !== 'agent' && opts.authorAgentId != null) {
    throw new Error("authorAgentId must be null when authorType is not 'agent'");
  }

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
  return firstOrThrow(rows);
}

export interface GetHistoryOpts {
  before?: number;
  after?: number;
  limit?: number;
}

export async function getHistory(db: DbOrTx, roomId: string, opts: GetHistoryOpts = {}): Promise<Array<{
  id: number;
  roomId: string;
  authorType: string;
  authorAgentId: string | null;
  content: string;
  replyTo: number | null;
  createdAt: Date | null;
  sender: string;
}>> {
  // Column references only; no user input interpolated
  const senderColumn = sql<string>`COALESCE(${agents.name}, CASE ${chatMessages.authorType} WHEN 'operator' THEN 'user' WHEN 'system' THEN 'system' ELSE NULL END, 'unknown')`.as('sender');

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
