import { eq, and, ne, desc } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { rooms, roomMembers, agents } from '../schema/tables.js';
import type { DbOrTx } from '../drizzle-instance.js';
import { firstOrThrow } from './query-helpers.js';

export type RoomRow = InferSelectModel<typeof rooms>;

export interface CreateRoomOpts {
  id: string;
  name: string;
  type: string;
  createdBy: string;
  projectId?: string;
}

export async function createRoom(db: DbOrTx, opts: CreateRoomOpts): Promise<RoomRow> {
  const rows = await db
    .insert(rooms)
    .values({
      id: opts.id,
      name: opts.name,
      type: opts.type,
      createdBy: opts.createdBy,
      projectId: opts.projectId ?? 'default',
    })
    .returning();
  return firstOrThrow(rows);
}

export async function getRoom(db: DbOrTx, id: string): Promise<RoomRow | null> {
  const rows = await db.select().from(rooms).where(eq(rooms.id, id));
  return rows[0] ?? null;
}

export interface ListRoomsOpts {
  member?: string;
  projectId?: string;
}

export async function listRooms(db: DbOrTx, opts: ListRoomsOpts = {}): Promise<RoomRow[]> {
  const roomSelect = {
    id: rooms.id,
    projectId: rooms.projectId,
    name: rooms.name,
    type: rooms.type,
    createdBy: rooms.createdBy,
    createdAt: rooms.createdAt,
  };

  if (opts.member) {
    // Resolve agent name to agent ID first
    const agentConditions = opts.projectId
      ? and(eq(agents.name, opts.member), eq(agents.projectId, opts.projectId))
      : eq(agents.name, opts.member);

    const agentRows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(agentConditions)
      .limit(1);

    if (agentRows.length === 0) {
      return [];
    }

    const agentId = agentRows[0].id;

    const rows = await db
      .select(roomSelect)
      .from(rooms)
      .innerJoin(roomMembers, eq(rooms.id, roomMembers.roomId))
      .where(
        opts.projectId
          ? and(eq(roomMembers.agentId, agentId), eq(rooms.projectId, opts.projectId))
          : eq(roomMembers.agentId, agentId),
      )
      .orderBy(desc(rooms.createdAt));
    return rows;
  }

  const conditions = [];
  if (opts.projectId) {
    conditions.push(eq(rooms.projectId, opts.projectId));
  }

  return db
    .select(roomSelect)
    .from(rooms)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(rooms.createdAt));
}

export async function deleteRoom(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.delete(rooms).where(eq(rooms.id, id)).returning();
  return rows.length > 0;
}

export async function addMember(db: DbOrTx, roomId: string, agentId: string): Promise<void> {
  await db
    .insert(roomMembers)
    .values({ id: uuidv7(), roomId, agentId })
    .onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.agentId] });
}

export async function removeMember(db: DbOrTx, roomId: string, agentId: string): Promise<void> {
  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)));
}

export async function getMembers(db: DbOrTx, roomId: string): Promise<Array<{ agentId: string; name: string }>> {
  return db
    .select({ agentId: roomMembers.agentId, name: agents.name })
    .from(roomMembers)
    .innerJoin(agents, eq(agents.id, roomMembers.agentId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(agents.name);
}

export async function getPresence(db: DbOrTx, roomId: string): Promise<Array<{ name: string; joinedAt: Date | null; online: boolean; status: string }>> {
  const rows = await db
    .select({
      name: agents.name,
      joinedAt: roomMembers.joinedAt,
      status: agents.status,
    })
    .from(roomMembers)
    .innerJoin(agents, eq(agents.id, roomMembers.agentId))
    .where(and(eq(roomMembers.roomId, roomId), ne(agents.status, 'deleted')))
    .orderBy(agents.name);

  return rows.map((r) => ({
    name: r.name,
    joinedAt: r.joinedAt,
    online: true,
    status: r.status,
  }));
}
