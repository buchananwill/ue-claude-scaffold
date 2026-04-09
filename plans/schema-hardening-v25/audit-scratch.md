# Cross-Table Reference Audit for Schema Hardening V2.5

This audit catalogues every read and write of the cross-table agent-reference columns
that will be migrated in this plan. Each section lists the schema column, then every
file:line that reads or writes it.

---

## 1. `tasks.claimedBy` (column `claimed_by`)

**Schema**: `server/src/schema/tables.ts:92` -- `claimedBy: text('claimed_by')`

### Writes (SET / INSERT)

- `server/src/queries/tasks-lifecycle.ts:10` -- `claimedBy: agent` (claim task)
- `server/src/queries/tasks-lifecycle.ts:71` -- `claimedBy: null` (complete task)
- `server/src/queries/tasks-lifecycle.ts:89` -- `claimedBy: null` (fail task)
- `server/src/queries/tasks-lifecycle.ts:177` -- `claimedBy: null` (release tasks by agent)
- `server/src/queries/tasks-lifecycle.ts:193` -- `claimedBy: null` (release all tasks)

### Reads (SELECT / WHERE)

- `server/src/queries/tasks-core.ts:48` -- selected as `claimedBy: tasks.claimedBy`
- `server/src/queries/tasks-core.ts:84-92` -- WHERE filter: `isNull(tasks.claimedBy)`, `eq(tasks.claimedBy, ...)`, `inArray(tasks.claimedBy, ...)`
- `server/src/queries/coalesce.ts:20` -- WHERE: `eq(tasks.claimedBy, agent)`
- `server/src/queries/coalesce.ts:68,74` -- selected as `claimedBy: tasks.claimedBy` for in-flight tasks
- `server/src/queries/tasks-lifecycle.ts:182` -- WHERE: `eq(tasks.claimedBy, agent)` for release

### Route / response layer

- `server/src/routes/tasks-types.ts:12` -- `claimed_by: string | null` (snake_case response)
- `server/src/routes/tasks-types.ts:23` -- `claimedBy?: string | null` (camelCase response)
- `server/src/routes/tasks-types.ts:42,53` -- format function maps `claimedBy`
- `server/src/routes/tasks-types.ts:97` -- `pick<string | null>(r, 'claimedBy', 'claimed_by')`
- `server/src/routes/search.ts:18,56` -- `claimedBy: row.claimedBy`
- `server/src/routes/coalesce.ts:80,142` -- `agent: r.claimedBy` (re-aliased to `agent` in response)

### Test files

- `server/src/queries/coalesce.test.ts:26-27,76` -- inserts with `claimedBy`, asserts on it
- `server/src/queries/tasks-lifecycle.test.ts:28,92,109` -- assert `claimedBy` value
- `server/src/routes/tasks.test.ts:176,298,1280` -- assert `claimedBy` in task response
- `server/src/routes/tasks-claim.test.ts:41,124,347,352,420,443` -- assert `claimedBy` in claim flow
- `server/src/routes/tasks-lifecycle.test.ts:119,155` -- assert `claimedBy` after complete/fail
- `server/src/routes/agents.test.ts:357-396,416,431,441` -- task cleanup on agent delete
- `server/src/routes/coalesce.test.ts:59` -- insert with `claimedBy`

### Raw SQL

- `server/src/queries/test-utils.ts:88` -- DDL string: `"claimed_by" text`

---

## 2. `files.claimant` (column `claimant`)

**Schema**: `server/src/schema/tables.ts:108` -- `claimant: text('claimant')`

### Writes

- `server/src/queries/task-files.ts:40` -- `.set({ claimant: agent, claimedAt: ... })` (claim files for task)
- `server/src/queries/files.ts:29-30` -- `.set({ claimant: null, claimedAt: null })` (releaseByClaimant)
- `server/src/queries/files.ts:36` -- `.set({ claimant: null, claimedAt: null })` (releaseAll)
- `server/src/queries/coalesce.ts:84` -- `.set({ claimant: null, claimedAt: null })` (coalesce release)

### Reads

- `server/src/queries/files.ts:13-16` -- WHERE filter: `eq(files.claimant, ...)` or `isNull(files.claimant)`
- `server/src/queries/task-files.ts:45` -- WHERE: `isNull(files.claimant)` (no conflict if unclaimed)
- `server/src/queries/task-files.ts:56,60` -- SELECT `claimant: files.claimant` (conflict check)
- `server/src/queries/task-files.ts:74-75` -- raw SQL: `files.claimant IS NOT NULL`, `files.claimant != ${agent}`
- `server/src/queries/task-files.ts:85,89` -- SELECT `claimant: files.claimant` (overlap check)
- `server/src/queries/task-files.ts:103` -- raw SQL: `files.claimant IS NOT NULL`
- `server/src/queries/coalesce.ts:40` -- WHERE: `isNotNull(files.claimant)` (count owned files)
- `server/src/queries/coalesce.ts:49` -- WHERE: `eq(files.claimant, agent)` (count files for agent)
- `server/src/queries/coalesce.ts:81` -- WHERE: `isNotNull(files.claimant)` (release all claimed files)

### Route / response layer

- `server/src/routes/files.ts:8,10,15,20` -- query param `claimant`, passed to query, mapped in response
- `server/src/routes/tasks-files.ts:14` -- type `claimant: string`
- `server/src/routes/tasks-files.ts:134,138,140,142-143,180` -- conflict formatting uses `claimant`

### Raw SQL

- `server/src/queries/tasks-claim.ts:12` -- `f.claimant IS NULL`
- `server/src/queries/tasks-claim.ts:21` -- `f2.claimant IS NOT NULL AND f2.claimant != ${agent}`
- `server/src/queries/tasks-claim.ts:61-62` -- `f.claimant IS NOT NULL AND f.claimant != ${agent}`
- `server/src/queries/test-utils.ts:102` -- DDL string: `"claimant" text`

### Test files

- `server/src/queries/composition.test.ts:53` -- `fileQ.list(db, 'default', { claimant: 'agent-1' })`
- `server/src/queries/task-files.test.ts:60` -- assert `c.claimant === 'agent-1'`
- `server/src/queries/coalesce.test.ts:34-36` -- insert with various `claimant` values
- `server/src/queries/files.test.ts:19-23,40-43,50,53,55,59,63` -- list/release by claimant
- `server/src/routes/ownership.test.ts:46-198` -- extensive claimant assertions
- `server/src/routes/files.test.ts:20,24,43,47,64,74` -- claimant filter and response checks
- `server/src/routes/coalesce.test.ts:63,67,161,259,261` -- claimant in coalesce flow

---

## 3. `buildHistory.agent` (column `agent`)

**Schema**: `server/src/schema/tables.ts:52` -- `agent: text('agent').notNull()`

### Writes

- `server/src/queries/builds.ts:14-15` -- `.values({ agent: opts.agent, ... })` (insertHistory)

### Reads

- `server/src/queries/builds.ts:72` -- WHERE: `eq(buildHistory.agent, agent)` (lastCompleted)
- `server/src/queries/builds.ts:93-94` -- WHERE: `eq(buildHistory.agent, opts.agent)` (list filter)

### Route / response layer

- `server/src/routes/builds.ts:19` -- `agent: row.agent` (formatBuildRecord)
- `server/src/routes/builds.ts:31-38` -- query param `agent` passed to buildsQ.list
- `server/src/routes/ubt.ts:22-24` -- `recordBuildStart` passes agent to `buildsQ.insertHistory`
- `server/src/routes/build.ts:310` -- `agentForHistory = agentName ?? 'unknown'` (fed to record)

### Test files

- `server/src/queries/builds.test.ts:90` -- `assert.ok(byAgent.every((b) => b.agent === 'agent-1'))`
- `server/src/routes/builds.test.ts:52,68` -- assert `agent` in build response

### Raw SQL

- (none beyond Drizzle ORM calls)

---

## 4. `ubtLock.holder` (column `holder`)

**Schema**: `server/src/schema/tables.ts:33` -- `holder: text('holder')`

### Writes

- `server/src/queries/ubt.ts:22,30` -- `holder` in INSERT/upsert (acquireLock)

### Reads

- `server/src/queries/ubt.ts:5-11` -- `getLock` returns full row including `holder`
- `server/src/queries/ubt.ts:106-111` -- `isAgentRegistered` checks if `holder` is registered agent
- `server/src/routes/ubt.ts:76-78` -- `lock.holder` stale-lock sweep, passed to `isAgentRegistered`
- `server/src/routes/ubt.ts:97-98` -- `lock?.holder` null check
- `server/src/routes/ubt.ts:108` -- `holder: lock.holder` in response
- `server/src/routes/ubt.ts:134,145,158` -- `lock.holder` comparison and response
- `server/src/routes/ubt.ts:178` -- `lock.holder !== agent` check in release
- `server/src/routes/build.ts:136,142,145` -- `lock.holder` comparison in checkLock

### Test files

- `server/src/queries/ubt.test.ts:30,38` -- assert `lock.holder`
- `server/src/routes/ubt.test.ts:27,121,147,165,214,236,249,255,283,308,340` -- assert `holder` in status/acquire/release/stale

### Raw SQL

- (none beyond Drizzle ORM calls)

---

## 5. `ubtQueue.agent` (column `agent`)

**Schema**: `server/src/schema/tables.ts:42` -- `agent: text('agent').notNull()`

### Writes

- `server/src/queries/ubt.ts:49` -- `.values({ agent, priority, projectId })` (enqueue)

### Reads

- `server/src/queries/ubt.ts:56-72` -- raw SQL `DELETE ... RETURNING *` returns `agent` (dequeue)
- `server/src/queries/ubt.ts:102` -- WHERE: `eq(ubtQueue.agent, agent)` (findInQueue)
- `server/src/routes/ubt.ts:62-63` -- `next.agent` used after dequeue to acquireLock and return `promoted`

### Test files

- `server/src/queries/ubt.test.ts:61,63,69,73` -- assert `queue[i].agent`

### Raw SQL

- `server/src/queries/ubt.ts:62-71` -- raw SQL `DELETE FROM ubt_queue ... RETURNING *` (column returned as `agent`)

---

## 6. `messages.fromAgent` (column `from_agent`)

**Schema**: `server/src/schema/tables.ts:66` -- `fromAgent: text('from_agent').notNull()`

**Note**: The plan references this as `messages.agent`. The actual schema column is `fromAgent` / `from_agent`.

### Writes

- `server/src/queries/messages.ts:21` -- `fromAgent: opts.fromAgent` (insert)

### Reads

- `server/src/queries/messages.ts:50-51` -- WHERE: `eq(messages.fromAgent, opts.fromAgent)` (list filter)
- `server/src/queries/messages.ts:101-102` -- WHERE: `eq(messages.fromAgent, opts.fromAgent)` (count filter)
- `server/src/queries/search.ts:39` -- `${messages.fromAgent} ILIKE ${pattern}` (full-text search)

### Route / response layer

- `server/src/routes/messages.ts:7` -- `fromAgent: string` in MessageRow interface
- `server/src/routes/messages.ts:35` -- `fromAgent: row.fromAgent` in formatMessage
- `server/src/routes/messages.ts:55` -- `fromAgent: agent ?? 'unknown'` (populated from `X-Agent-Name` header)
- `server/src/routes/messages.ts:66,69,76` -- query param `from_agent` passed as `fromAgent` filter
- `server/src/routes/messages.ts:84,87,96` -- same pattern for paginated list
- `server/src/routes/search.ts:52` -- `fromAgent: row.fromAgent`

### Semantic analysis (decision for Phase 2)

**How it is populated**: At `server/src/routes/messages.ts:51,55`, the value is taken from the `X-Agent-Name` HTTP header (`request.headers['x-agent-name']`) with a fallback of `'unknown'`. This header is set by agent containers and identifies the registered agent.

**How it is read**: It is filtered by exact match against agent names (messages.ts:50-51, 101-102), used in full-text search (search.ts:39), and returned in responses as `fromAgent` (messages.ts:35, search.ts:52).

**Decision**: **Referential -- rename to `agentId`**. The column is always populated from the `X-Agent-Name` header which corresponds to the `agents.name` PK. It is never used as a free-form label. The fallback value `'unknown'` is a sentinel for anonymous/unregistered requests, not a descriptive label. All query filters treat it as an exact agent identifier. This column should become a proper FK reference to `agents.id` (once agents get a UUID PK).

### Test files

- `server/src/queries/messages.test.ts:22,33-34,67-69,84,95,107,121,133-134,140-142` -- insert/filter with `fromAgent`
- `server/src/queries/search.test.ts:25-26,65` -- insert with `fromAgent`, assert match
- `server/src/routes/messages.test.ts:38` -- assert `fromAgent` in response
- `server/src/routes/status.test.ts:53,90,115,122,130,156,164` -- insert/assert `fromAgent`
- `server/src/routes/search.test.ts:59,108` -- insert with `fromAgent`

### Raw SQL

- `server/src/queries/test-utils.ts:64` -- DDL string: `"from_agent" text NOT NULL`

---

## 7. `messages.claimedBy` (column `claimed_by`)

**Schema**: `server/src/schema/tables.ts:70` -- `claimedBy: text('claimed_by')`
**Index**: `server/src/schema/tables.ts:78` -- `index('idx_messages_claimed').on(table.claimedBy)`

### Writes

- `server/src/queries/messages.ts:119` -- `.set({ claimedBy, claimedAt: ... })` (claim message)

### Reads

- `server/src/queries/messages.ts:120` -- WHERE: `isNull(messages.claimedBy)` (only claim if unclaimed)

### Route / response layer

- `server/src/routes/messages.ts:11,39` -- `claimedBy: string | null` in interface, mapped in format

### Test files

- (no explicit tests found asserting `messages.claimedBy` directly; claim flow tested via `/messages/:id/claim` endpoint)

### Raw SQL

- `server/src/queries/test-utils.ts:68,76` -- DDL strings: `"claimed_by" text`, index on `claimed_by`

---

## 8. `roomMembers.member` (column `member`)

**Schema**: `server/src/schema/tables.ts:149` -- `member: text('member').notNull()`
**PK**: `server/src/schema/tables.ts:152` -- `primaryKey({ columns: [table.roomId, table.member] })`

### Writes

- `server/src/queries/rooms.ts:80-84` -- `.values({ roomId, member })` (addMember)
- `server/src/queries/teams.ts:58` -- `.values({ roomId: opts.id, member: m.agentName })` (team creation adds members to room)

### Reads

- `server/src/queries/rooms.ts:41-57` -- WHERE/JOIN: `eq(roomMembers.member, opts.member)` (listRooms filter)
- `server/src/queries/rooms.ts:90` -- WHERE: `eq(roomMembers.member, member)` (removeMember)
- `server/src/queries/rooms.ts:95-98` -- SELECT: `roomMembers.member` (getMembers)
- `server/src/queries/rooms.ts:104,110,112,115` -- SELECT/JOIN: `roomMembers.member` joined with `agents.name` (getPresence)
- `server/src/queries/chat.ts:72-74` -- WHERE: `eq(roomMembers.member, member)` (isMember check)

### Route / response layer

- `server/src/routes/rooms.ts:38` -- query param `member` passed to listRooms
- `server/src/routes/rooms.ts:74` -- `member: m.member` in room detail response
- `server/src/routes/rooms.ts:137` -- `request.params.member` passed to removeMember

### Test files

- `server/src/routes/rooms.test.ts:54,61,108,161,183,431` -- assert/extract `.member` from responses
- `server/src/routes/teams.test.ts:95` -- `m.member` from team room members

### Raw SQL

- `server/src/queries/test-utils.ts:137` -- DDL string: `CONSTRAINT "room_members_room_id_member_pk" PRIMARY KEY("room_id", "member")`

---

## 9. `teamMembers.agentName` (column `agent_name`)

**Schema**: `server/src/schema/tables.ts:198` -- `agentName: text('agent_name').notNull()`
**PK**: `server/src/schema/tables.ts:202` -- `primaryKey({ columns: [table.teamId, table.agentName] })`

### Writes

- `server/src/queries/teams.ts:42` -- loop calling `addMember(db, opts.id, m.agentName, m.role, m.isLeader)` (team create)
- `server/src/queries/teams.ts:139` -- `.values({ teamId, agentName, role, isLeader })` (addMember upsert)

### Reads

- `server/src/queries/teams.ts:120` -- SELECT: `agentName: teamMembers.agentName` (getMembers)
- `server/src/queries/teams.ts:144` -- ON CONFLICT target: `[teamMembers.teamId, teamMembers.agentName]`
- `server/src/queries/teams.ts:152` -- WHERE: `eq(teamMembers.agentName, agentName)` (removeMember)

### Route / response layer

- `server/src/routes/teams.ts:31` -- request body type: `members: Array<{ agentName: string; ... }>`
- `server/src/routes/teams.ts:43-46` -- validation: `AGENT_NAME_RE.test(m.agentName)`
- `server/src/routes/teams.ts:49,52` -- validation error messages referencing `agentName`
- `server/src/routes/teams.ts:137` -- response mapping: `agentName: m.agentName`

### Team launcher

- `server/src/team-launcher.ts:20,50` -- `agentName: string` in interfaces
- `server/src/team-launcher.ts:120,123,128-138` -- validation of `agentName` (duplicates, format, required)
- `server/src/team-launcher.ts:196,223,229` -- `agentName: m.agentName` in team creation/response

### Test files

- `server/src/queries/teams.test.ts:49,54,62,121-122` -- assert/insert with `agentName`
- `server/src/routes/teams.test.ts:58-59,73,88-89,95,104-105,116-117,144,148,160,164,200-201,216,220,251,272,303,321,338,442,448,452,455,462,472,482` -- extensive `agentName` usage
- `server/src/team-launcher.test.ts:91-92,115-116,121,131,146,159,189-190,214,219,255,309-310,329,340-341,394,400,420,425` -- team launcher tests

### Raw SQL

- `server/src/queries/test-utils.ts:167` -- DDL string: `CONSTRAINT "team_members_team_id_agent_name_pk" PRIMARY KEY("team_id", "agent_name")`

---

## 10. `chatMessages.sender` (column `sender`)

**Schema**: `server/src/schema/tables.ts:159` -- `sender: text('sender').notNull()`

### Writes

- `server/src/queries/chat.ts:20` -- `sender: opts.sender` (sendMessage)

### Reads

- (no WHERE filter on sender in queries -- messages are fetched by room, not by sender)

### Route / response layer

- `server/src/routes/rooms.ts:209` -- `sender: r.sender` in message response
- `server/src/routes/rooms.ts:226,234` -- raw SQL: `cm.sender` in transcript query
- `server/src/routes/rooms.ts:251` -- `${r.sender}:` in plain-text transcript formatting

### Test files

- `server/src/queries/chat.test.ts:47` -- `assert.equal(msg.sender, 'alice')`

### Raw SQL

- `server/src/routes/rooms.ts:226,234` -- `cm.sender` in raw SQL transcript queries

---

## Summary of `messages.fromAgent` Decision

**Decision: Referential -- rename to `agentId`.**

Rationale:
1. The column is always populated from `X-Agent-Name` header (server/src/routes/messages.ts:51,55), which identifies a registered agent.
2. All query filters use exact-match comparison against agent names.
3. The `'unknown'` fallback is a sentinel, not a descriptive label.
4. No code path treats it as a free-form text field.

This means Phase 2 should add a proper `agentId` UUID FK column and migrate `fromAgent` to reference `agents.id`.
