import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
  foreignKey,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// 1. agents
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  projectId: text('project_id').notNull().references(() => projects.id),
  worktree: text('worktree').notNull(),
  planDoc: text('plan_doc'),
  // Valid values: idle | working | done | error | paused | stopping | deleted
  status: text('status').notNull().default('idle'),
  mode: text('mode').notNull().default('single'),
  registeredAt: timestamp('registered_at').defaultNow(),
  containerHost: text('container_host'),
  sessionToken: text('session_token').unique(),
}, (table) => [
  unique('agents_project_name_unique').on(table.projectId, table.name),
]);

// 2. ubtLock — host-level singleton mutex (one lock per UBT host)
export const ubtLock = pgTable('ubt_lock', {
  hostId: text('host_id').primaryKey().default('local'),
  holderAgentId: uuid('holder_agent_id').references(() => agents.id, { onDelete: 'restrict' }),
  acquiredAt: timestamp('acquired_at'),
  priority: integer('priority').default(0),
});

// 3. ubtQueue — global FIFO with priority (all agents, all projects)
export const ubtQueue = pgTable('ubt_queue', {
  id: serial('id').primaryKey(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  priority: integer('priority').default(0),
  requestedAt: timestamp('requested_at').defaultNow(),
});

// 4. buildHistory
export const buildHistory = pgTable('build_history', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  agent: text('agent').notNull(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
  type: text('type').notNull(),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  durationMs: integer('duration_ms'),
  success: integer('success'),
  output: text('output'),
  stderr: text('stderr'),
}, (table) => [
  check('build_history_type_check', sql`${table.type} IN ('build', 'test')`),
]);

// 5. messages
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  fromAgent: text('from_agent').notNull(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
  channel: text('channel').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at'),
  resolvedAt: timestamp('resolved_at'),
  result: jsonb('result'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_messages_channel').on(table.channel),
  index('idx_messages_channel_id').on(table.channel, table.id),
  index('idx_messages_claimed').on(table.claimedBy),
]);

// 6. tasks
export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  description: text('description').default(''),
  sourcePath: text('source_path'),
  acceptanceCriteria: text('acceptance_criteria'),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  basePriority: integer('base_priority').notNull().default(0),
  claimedByAgentId: uuid('claimed_by_agent_id').references(() => agents.id, { onDelete: 'restrict' }),
  claimedAt: timestamp('claimed_at'),
  completedAt: timestamp('completed_at'),
  result: jsonb('result'),
  progressLog: text('progress_log'),
  agentTypeOverride: text('agent_type_override'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  check('tasks_status_check', sql`${table.status} IN ('pending','claimed','in_progress','completed','failed','integrated','cycle')`),
  check('tasks_agent_type_override_check', sql`${table.agentTypeOverride} IS NULL OR ${table.agentTypeOverride} ~ '^[a-zA-Z0-9_-]{1,64}$'`),
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_priority').on(table.priority.desc(), table.id.asc()),
]);

// 7. files
export const files = pgTable('files', {
  projectId: text('project_id').notNull().references(() => projects.id),
  path: text('path').notNull(),
  claimantAgentId: uuid('claimant_agent_id').references(() => agents.id, { onDelete: 'restrict' }),
  claimedAt: timestamp('claimed_at'),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.path] }),
]);

// 8. taskFiles
export const taskFiles = pgTable('task_files', {
  taskId: integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.filePath] }),
  index('idx_task_files_path').on(table.filePath),
]);

// 9. taskDependencies
export const taskDependencies = pgTable('task_dependencies', {
  taskId: integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOn: integer('depends_on').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.dependsOn] }),
  check('task_deps_no_self', sql`${table.taskId} != ${table.dependsOn}`),
  index('idx_task_deps_task').on(table.taskId),
  index('idx_task_deps_dep').on(table.dependsOn),
]);

// 10. rooms
export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  type: text('type').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  check('rooms_type_check', sql`${table.type} IN ('group','direct')`),
]);

// 11. roomMembers
export const roomMembers = pgTable('room_members', {
  id: uuid('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  joinedAt: timestamp('joined_at').defaultNow(),
}, (table) => [
  unique('room_members_room_agent_unique').on(table.roomId, table.agentId),
]);

// 12. chatMessages
export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  authorType: text('author_type').notNull(),
  authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'restrict' }),
  content: text('content').notNull(),
  replyTo: integer('reply_to'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_chat_room_id').on(table.roomId, table.id),
  foreignKey({ columns: [table.replyTo], foreignColumns: [table.id] }).onDelete('set null'),
]);

// 13. teams
export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  briefPath: text('brief_path'),
  status: text('status').notNull().default('active'),
  deliverable: text('deliverable'),
  createdAt: timestamp('created_at').defaultNow(),
  dissolvedAt: timestamp('dissolved_at'),
}, (table) => [
  check('teams_status_check', sql`${table.status} IN ('active','converging','dissolved')`),
]);

// 14. projects — portable project configuration (no filesystem paths)
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  engineVersion: text('engine_version'),
  seedBranch: text('seed_branch'),
  buildTimeoutMs: integer('build_timeout_ms'),
  testTimeoutMs: integer('test_timeout_ms'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  check('projects_id_check', sql`${table.id} ~ '^[a-zA-Z0-9_-]{1,64}$'`),
]);

// 15. teamMembers
export const teamMembers = pgTable('team_members', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  role: text('role').notNull(),
  isLeader: boolean('is_leader').notNull().default(false),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.agentId] }),
  uniqueIndex('idx_team_leader').on(table.teamId).where(sql`is_leader = true`),
]);
