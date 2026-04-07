import { eq, and, gt, lt, desc, asc } from 'drizzle-orm';
import { chatMessages, roomMembers } from '../schema/tables.js';
import type { DrizzleDb, DrizzleTx } from '../drizzle-instance.js';

/** Accept either a full DB instance or a transaction client. */
type DbOrTx = DrizzleDb | DrizzleTx;

export interface SendMessageOpts {
  roomId: string;
  sender: string;
  content: string;
  replyTo?: number | null;
}

export async function sendMessage(db: DbOrTx, opts: SendMessageOpts) {
  const rows = await db
    .insert(chatMessages)
    .values({
      roomId: opts.roomId,
      sender: opts.sender,
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

export async function getHistory(db: DbOrTx, roomId: string, opts: GetHistoryOpts = {}) {
  const pageSize = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  if (opts.after != null) {
    // after cursor: WHERE id > after, ORDER BY id ASC, LIMIT
    return db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.roomId, roomId), gt(chatMessages.id, opts.after)))
      .orderBy(asc(chatMessages.id))
      .limit(pageSize);
  }

  if (opts.before != null) {
    // before cursor: WHERE id < before, ORDER BY id DESC, LIMIT, then reverse
    const rows = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.roomId, roomId), lt(chatMessages.id, opts.before)))
      .orderBy(desc(chatMessages.id))
      .limit(pageSize);
    rows.reverse();
    return rows;
  }

  // latest: ORDER BY id DESC, LIMIT, then reverse
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.roomId, roomId))
    .orderBy(desc(chatMessages.id))
    .limit(pageSize);
  rows.reverse();
  return rows;
}

export async function isMember(db: DbOrTx, roomId: string, member: string): Promise<boolean> {
  const rows = await db
    .select({ member: roomMembers.member })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.member, member)));
  return rows.length > 0;
}
