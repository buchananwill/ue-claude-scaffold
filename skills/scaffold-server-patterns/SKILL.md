---
name: scaffold-server-patterns
description: Fastify plugin conventions, ESM patterns, Drizzle ORM + PGlite usage, route structure, and typed handler patterns for the ue-claude-scaffold coordination server.
axis: domain
---

# Scaffold Server Patterns

Domain knowledge for the coordination server in `server/`.

## Fastify Plugin Pattern

Every route file exports a `FastifyPluginAsync` as its default export. The plugin receives `{ config }` in its options.

```typescript
import type { FastifyPluginAsync } from 'fastify'
import type { ScaffoldConfig } from '../config.js'

interface PluginOpts {
  config: ScaffoldConfig
}

const plugin: FastifyPluginAsync<PluginOpts> = async (app, { config }) => {
  app.get('/endpoint', async (request, reply) => {
    // handler
  })
}

export default plugin
```

## ESM Import Convention

All imports use `.js` extensions, even when the source file is `.ts`:

```typescript
// CORRECT
import { getDrizzleDb } from './drizzle-instance.js'
import { agents } from './schema/tables.js'
import agentsPlugin from './routes/agents.js'

// WRONG — will fail at runtime
import { getDrizzleDb } from './drizzle-instance'
import agentsPlugin from './routes/agents.ts'
```

## Database: Drizzle + PGlite

- Drizzle ORM with two drivers: PGlite (in-process Postgres for dev and tests) and node-postgres (prod via `DATABASE_URL`)
- Schema defined in `server/src/schema/tables.ts`, indexed by `server/src/schema/index.ts`
- Migrations live in `server/drizzle/` and apply via `npm run db:migrate` (which runs `src/migrate.ts`)
- Query construction goes through Drizzle's typed builder API — never raw SQL strings:

```typescript
// CORRECT — typed builder
import { eq } from 'drizzle-orm'
import { agents } from '../schema/tables.js'

await db.select().from(agents).where(eq(agents.name, name))
await db.insert(agents).values({ name, projectId, status: 'active' })
```

- Transactions use `db.transaction(async (tx) => { ... })`. Functions that need to work inside or outside a transaction accept `DbOrTx` from `drizzle-instance.ts`:

```typescript
import type { DbOrTx } from '../drizzle-instance.js'

async function upsertAgent(db: DbOrTx, name: string, projectId: string) {
  return db.insert(agents).values({ name, projectId }).onConflictDoNothing()
}
```

- Tests use `drizzle-test-helper.createDrizzleTestApp()` to spin up an isolated PGlite instance with the schema applied. Never share DB state across tests.
- Raw SQL fragments (`` sql`...` ``) are allowed only for PG-specific features that Drizzle's builder cannot express. Always parameterize with `${variable}` placeholders — never string-interpolate user input:

```typescript
// CORRECT — parameterized raw fragment
import { sql } from 'drizzle-orm'
await db.execute(sql`SELECT pg_advisory_lock(${lockId})`)

// WRONG — string interpolation (SQL injection risk)
await db.execute(sql.raw(`SELECT pg_advisory_lock(${lockId})`))
```

## Agent and Project Identification

Agents identify themselves via the `X-Agent-Name` HTTP header on requests to the coordination server. Routes that need agent context read this header.

Every request must also carry an `X-Project-Id` header. The `project-id` plugin (`server/src/plugins/project-id.ts`) reads this header in a `preHandler` hook and decorates `request.projectId`. A missing header defaults to `'default'`, which silently scopes the request to the wrong project — write any new client (curl example, hook, MCP server) so it always sets `X-Project-Id` from the container's `PROJECT_ID` env var.

## Error Helpers

`@fastify/sensible` is registered, providing:
- `app.httpErrors.notFound('message')`
- `app.httpErrors.badRequest('message')`
- `reply.notFound()`, `reply.badRequest()`, etc.

## Route Registration

Plugins are registered on the Fastify instance with config:

```typescript
await app.register(agentsPlugin, { config })
await app.register(tasksPlugin, { config })
```

## Response Shapes

Successful responses return the data directly or `{ ok: true, ... }`. Error responses use Fastify sensible's built-in error format or explicit `{ error: 'message' }` objects.
