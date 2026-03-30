---
name: scaffold-test-format
description: Test file structure, imports, setup/teardown, and assertion patterns for the ue-claude-scaffold server using Node.js built-in test runner with tsx.
axis: schema
---

# Scaffold Test Format

Standard test structure for server tests in `server/src/`.

## Template

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js'
import myPlugin from './my-route.js'

describe('my-route', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestApp()
    await ctx.app.register(myPlugin, { config: createTestConfig() })
  })

  afterEach(async () => {
    await ctx.app.close()
    ctx.cleanup()
  })

  it('GET /endpoint returns expected shape', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/endpoint' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [])
  })

  it('POST /endpoint creates a resource', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/endpoint',
      payload: { name: 'test' },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
  })
})
```

## Rules

- **Imports**: `node:test` for test structure, `node:assert/strict` for assertions. Never import from Jest, Vitest, or supertest.
- **Isolation**: `createTestApp()` gives each test suite its own Fastify instance and temp SQLite DB. Tests never share state.
- **Registration**: Register only the plugin(s) under test. Use `createTestConfig()` for default config, with optional overrides.
- **HTTP testing**: Use `ctx.app.inject()` — no real server, no network. Returns a response object with `.statusCode`, `.json()`, `.body`, `.headers`.
- **Cleanup**: Always `ctx.app.close()` + `ctx.cleanup()` in `afterEach`. Cleanup removes the temp DB files and directory.
- **File placement**: Test files live next to their source: `src/routes/agents.test.ts` tests `src/routes/agents.ts`.
- **Running**: Single file: `npx tsx --test src/routes/<file>.test.ts`. All tests: `npm test`.

## Assertion Patterns

```typescript
// Equality
assert.equal(res.statusCode, 200)
assert.equal(body.name, 'test')

// Deep equality (objects, arrays)
assert.deepEqual(res.json(), [])
assert.deepEqual(body, { ok: true, name: 'test' })

// Truthiness
assert.ok(typeof body.id === 'string', 'id should be a string')

// Throws
assert.throws(() => riskyFunction(), /expected error pattern/)
await assert.rejects(asyncRiskyFunction(), /pattern/)
```
