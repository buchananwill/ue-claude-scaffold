# Phase 2 — Task creation: accept and persist agent_type_override

Part of [Task Agent Type Override](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** `POST /tasks`, `POST /tasks/batch`, and task ingestion accept and persist `agentTypeOverride`. The field
appears in task API responses.

**Types / APIs:**

```ts
// TaskBody gains:
agentTypeOverride ? : string;

// TaskRow gains:
agentTypeOverride: string | null;

// InsertOpts gains:
agentTypeOverride ? : string;
```

**Work:**

- Add `agentTypeOverride` to `TaskBody`, `taskBodyKeys`, `PatchBody`, and `patchBodyKeys` in
  `server/src/routes/tasks-files.ts`.
- Add `agentTypeOverride` to `TaskRow` and `toTaskRow` in `server/src/routes/tasks-types.ts`.
- Add `agentTypeOverride` to `formatTask` output in `server/src/routes/tasks-types.ts`.
- Add `agentTypeOverride` to `InsertOpts` and the `insert` function in `server/src/queries/tasks-core.ts`.
- Thread `agentTypeOverride` through the `POST /tasks` handler in `server/src/routes/tasks.ts`.
- Thread `agentTypeOverride` through the `POST /tasks/batch` handler in `server/src/routes/tasks.ts`.
- Add `agentTypeOverride` to the frontmatter parsing in `server/src/task-ingest.ts` (read from `agent_type_override` or
  `agentTypeOverride` frontmatter key).
- Validate `agentTypeOverride`, when provided, via `isValidAgentName` exported from [server/src/branch-naming.ts](../../server/src/branch-naming.ts) (wraps the exported `AGENT_NAME_RE`). Do not inline or duplicate the regex pattern — import the helper.

**Verification:** `npm test` passes. Create a task with `agentTypeOverride: "container-reviewer"` — the response
includes the field. Create without it — field is `null`. `PATCH /tasks/:id` can update the field. Ingest a markdown file
with `agent_type_override: container-implementer` in frontmatter — stored correctly.
