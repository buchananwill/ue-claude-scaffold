# Phase 3 — Server endpoint: compile and serve agent definitions

Part of [Task Agent Type Override](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** `GET /agents/definitions/:type` compiles and returns a agent definition file (markdown + meta.json sidecar)
on demand. The server uses the same `compileAgent` function from `server/src/agent-compiler.ts` that `launch.sh` uses at
build time.

**Types / APIs:**

```ts
// GET /agents/definitions/:type
// Response:
{
    agentType: string;
    markdown: string;      // compiled agent .md content
    meta: {
        "access-scope"
    :
        string
    }
    ;  // sidecar metadata
}
```

**Work:**

- Create `server/src/routes/agent-definitions.ts` as a Fastify plugin.
- The handler takes `:type` from the URL, validates it against `AGENT_NAME_RE`.
- Locate the source file: check `dynamic-agents/{type}.md` first, fall back to `agents/{type}.md`.
- If the source is a dynamic agent (has `skills` in frontmatter), call `compileAgent` from
  `server/src/agent-compiler.ts` to compile it to a temp directory, read the output, and return both the markdown and
  sidecar JSON.
- If the source is a static agent (no `skills`), read and return it directly with a default meta of
  `{ "access-scope": "read-only" }`.
- Return 404 if the type doesn't exist as either a dynamic or static agent.
- Register the plugin in `server/src/routes/index.ts`.

**Verification:** `npm test` passes. `GET /agents/definitions/container-implementer` returns the compiled markdown and
meta. `GET /agents/definitions/nonexistent` returns 404.
