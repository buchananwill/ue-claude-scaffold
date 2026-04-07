---
name: scaffold-server-patterns
description: Fastify plugin conventions, ESM patterns, better-sqlite3 usage, route structure, and typed handler patterns for the ue-claude-scaffold coordination server.
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
import { openDb } from './db.js'
import agentsPlugin from './routes/agents.js'

// WRONG — will fail at runtime
import { openDb } from './db'
import agentsPlugin from './routes/agents.ts'
```

## Database: better-sqlite3

- WAL mode enabled for concurrent read performance
- Schema embedded in `src/db.ts` as DDL statements in `openDb()` — no migration files
- Always use parameterized queries with `?` placeholders:

```typescript
// CORRECT — parameterized
db.prepare('SELECT * FROM agents WHERE name = ?').get(name)
db.prepare('INSERT INTO messages (channel, body) VALUES (?, ?)').run(channel, body)

// WRONG — string interpolation (SQL injection risk)
db.prepare(`SELECT * FROM agents WHERE name = '${name}'`).get()
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
