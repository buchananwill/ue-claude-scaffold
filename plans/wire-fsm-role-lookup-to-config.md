# Wire FSM Role Lookup to scaffold.config.json

## Goal

Restore the durable-task FSM's distinct-agent-per-role behaviour by routing the role-→-agent lookup through `scaffold.config.json` (the source of truth) instead of `projects.agent_roles` (the DB column that was removed in migration [`0007_fork_tasks_for_fsm.sql`](./../server/drizzle/0007_fork_tasks_for_fsm.sql)).

Without this fix, every FSM role (engineer / each reviewer / arbitrator) silently launches as the same single agent definition — the container's default `AGENT_TYPE` — because the daisy-chain's per-role lookup returns an empty map. The FSM's review fan-out reduces to "engineer reviewing engineer", which collapses the whole point of the rework.

## Context

- The FSM's role-→-agent mapping is operator-local config, not portable project state: agent definitions are markdown under [`dynamic-agents/`](./../dynamic-agents/) on the operator's machine, compiled on demand to `.compiled-agents/`. Storing the mapping in a shared DB column (Supabase) would require every operator to push their local agent names into shared state — which is why migration `0007` dropped `projects.agent_roles`.
- The intended source of truth is `scaffold.config.json` under `projects.<id>.agentRoles`. The example file [`scaffold.config.example.json`](./../scaffold.config.example.json) already documents the shape; the loader does not yet parse it.
- The server already loads `scaffold.config.json` at startup ([`server/src/config.ts:loadConfig`](./../server/src/config.ts)) and exposes a per-project resolved view at `GET /config/:projectId` ([`server/src/routes/config.ts`](./../server/src/routes/config.ts), backed by [`server/src/config-resolver.ts:resolveProjectConfig`](./../server/src/config-resolver.ts)).
- The container daisy-chain reads role mappings in [`container/lib/pump-loop.sh:_resolve_roles_for_task`](./../container/lib/pump-loop.sh). Today it fetches from `/projects/${PROJECT_ID}` (DB row, no `agentRoles` field anymore) and falls back to `{}` via the jq selector `.agentRoles // {}`. Per-task overrides come from `tasks.agent_roles_override` (still in the schema, still merged on top).
- Degraded mode (no `agentRoles` configured for a project) is acceptable as a runtime fallback so partially-migrated operator configs don't wedge their containers. Hard validation only fires when an operator *has* configured `agentRoles` but written it in a broken shape — that's loud, operator-fixable, and worth surfacing at server start.

<!-- PHASE-BOUNDARY -->

## Phase 1 — Parse and validate `agentRoles` in the config loader

**Outcome:** [`server/src/config.ts:loadConfig`](./../server/src/config.ts) returns a `ScaffoldConfig` where each entry in `resolvedProjects` may carry a typed, validated `agentRoles` field. Malformed shapes throw at config-load with a specific error string naming the project and the failing rule. Missing `agentRoles` is tolerated (left `undefined`).

**Types / APIs:**

```typescript
// server/src/config.ts — new export
export interface AgentRoleMap {
  engineer: string;
  arbitrator: string;
  reviewers: Record<string, string>;
}

// server/src/config.ts — extend existing ProjectConfig
export interface ProjectConfig {
  // ... existing fields (name, path, uprojectFile, bareRepoPath, seedBranch,
  //     engine, build, plugins, stagingWorktreeRoot)
  agentRoles?: AgentRoleMap;
}

// server/src/config.ts — new internal validator
function validateAgentRoles(
  projectId: string,
  raw: unknown,
): AgentRoleMap | undefined;
```

**Validation rules** (applied per project during `loadConfig` when `agentRoles` is present):

| Field          | Rule                                                                              |
|----------------|-----------------------------------------------------------------------------------|
| `engineer`     | required; string matching `^[a-zA-Z0-9_-]{1,64}$`                                 |
| `arbitrator`   | required; same regex                                                              |
| `reviewers`    | required; plain object with ≥1 entry                                              |
| reviewer keys  | each key matches `^[a-z][a-z0-9_-]{0,31}$` (reviewer-role slug)                   |
| reviewer values| each value matches `^[a-zA-Z0-9_-]{1,64}$` (agent basename)                       |
| extra top-keys | unknown top-level keys (anything other than `engineer`/`arbitrator`/`reviewers`) are rejected |

On any rule violation, throw `Error(\`Invalid agentRoles for project '${projectId}': <specific issue>\`)`. The error must name the projectId and identify which rule failed (e.g. `"missing required field 'engineer'"`, `"reviewer key 'Safety' does not match [a-z][a-z0-9_-]{0,31}"`, `"unknown top-level key 'reviwers' — did you mean 'reviewers'?"`).

**Work:**
- Add the `AgentRoleMap` interface and `validateAgentRoles` helper to [`server/src/config.ts`](./../server/src/config.ts).
- Extend the `ProjectConfig` interface with an optional `agentRoles?: AgentRoleMap` field.
- In `loadConfig`, after parsing `resolvedProjects[id]`, call `validateAgentRoles(id, raw.agentRoles)` and assign the validated map (or `undefined`) onto the project's resolved entry.
- Extend [`server/src/config.test.ts`](./../server/src/config.test.ts) with cases:
  - valid `agentRoles` block — parses through, types match.
  - missing `agentRoles` — project resolves with `agentRoles` undefined.
  - missing `engineer` — throws with project name in the message.
  - empty `reviewers` map — throws.
  - reviewer key with uppercase — throws naming the offending key.
  - reviewer value with disallowed character (e.g. space) — throws.
  - unknown top-level key — throws.

**Verification:** `cd server && npx tsx --test src/config.test.ts` passes the new cases.

<!-- PHASE-BOUNDARY -->

## Phase 2 — Surface `agentRoles` on `GET /config/:projectId`

**Outcome:** `GET /config/:projectId` returns an `agentRoles` field on its JSON response: the validated map when configured, or `null` when not configured for that project.

**Types / APIs:**

```typescript
// server/src/config-resolver.ts — extend existing ResolvedProjectConfig
export interface ResolvedProjectConfig {
  // ... existing fields
  agentRoles: AgentRoleMap | null;
}
```

**Work:**
- Import `AgentRoleMap` from [`server/src/config.ts`](./../server/src/config.ts) into [`server/src/config-resolver.ts`](./../server/src/config-resolver.ts).
- Add `agentRoles: AgentRoleMap | null` to the `ResolvedProjectConfig` interface.
- In `resolveProjectConfig`, set the returned object's `agentRoles` field to `merged.agentRoles ?? null` (where `merged` is the resolved `ProjectConfig` from `getProject`).
- Extend [`server/src/routes/config.test.ts`](./../server/src/routes/config.test.ts) with two test cases:
  - `GET /config/<id>` for a project that has `agentRoles` configured — response includes the map verbatim.
  - `GET /config/<id>` for a project without `agentRoles` — response includes `agentRoles: null`.

**Verification:** `cd server && npx tsx --test src/routes/config.test.ts` passes. Manual: with a populated `scaffold.config.json` running locally, `curl http://localhost:9100/config/<projectId> | jq .agentRoles` returns the expected shape.

<!-- PHASE-BOUNDARY -->

## Phase 3 — Switch `pump-loop.sh` role lookup to `/config/:projectId`

**Outcome:** [`container/lib/pump-loop.sh:_resolve_roles_for_task`](./../container/lib/pump-loop.sh) fetches role mappings from `${SERVER_URL}/config/${PROJECT_ID}` instead of `${SERVER_URL}/projects/${PROJECT_ID}`. The per-task `agentRolesOverride` shallow-merge from `tasks.agent_roles_override` continues to work unchanged.

**Types / APIs:** shell function signature unchanged. Only the curl target URL changes.

**Work:**
- In [`container/lib/pump-loop.sh`](./../container/lib/pump-loop.sh), inside `_resolve_roles_for_task`, change the line:
  ```bash
  proj_resp=$(_curl_server -sf "${SERVER_URL}/projects/${PROJECT_ID}" --max-time 10 2>/dev/null) || proj_resp=""
  ```
  to:
  ```bash
  proj_resp=$(_curl_server -sf "${SERVER_URL}/config/${PROJECT_ID}" --max-time 10 2>/dev/null) || proj_resp=""
  ```
- The downstream jq filter `.agentRoles // {}` already handles the `null` case (Phase 2 returns `null` for unconfigured projects).
- Update the function's leading comment to name `/config/:projectId` as the lookup source and state that the authoritative source of truth is `scaffold.config.json` on the host where the server runs. Remove any stale reference to a `projects.agent_roles` DB column.
- Sanity: `bash -n container/lib/pump-loop.sh` passes.

**Verification:** With `agentRoles` populated in `scaffold.config.json` and the server running, launch one container as a pump (`./launch.sh --pump`) and claim one task. The container log should contain `Daisy-chain: role 'engineer' → agent 'container-implementer-ue'` (or whatever basename the operator configured) for the engineer cycle, and the matching reviewer / arbitrator basenames in subsequent cycles. Without `agentRoles` configured: same launch, same task — the daisy-chain log shows the default agent for all roles (degraded mode), and the task still completes through `pending → claimed → engineering → built → reviewing → complete`.

<!-- PHASE-BOUNDARY -->

## Phase 4 — Populate `agentRoles` in the live `scaffold.config.json`

**Outcome:** Every project the operator runs FSM containers against has its role wiring filled in under `projects.<id>.agentRoles` in the live `scaffold.config.json`. The server picks up the new config on restart, `/config/<id>` returns the populated map, and an end-to-end smoke task completes with each role launching its own agent definition.

**Types / APIs:** none. This is an operator-config edit.

**Work:**
- Open the live `scaffold.config.json` (operator-local, not committed to git).
- For each project that participates in FSM task execution, add an `agentRoles` block:
  ```json
  "agentRoles": {
    "engineer": "container-implementer-ue",
    "arbitrator": "container-arbitrator-ue",
    "reviewers": {
      "safety": "container-safety-reviewer-ue",
      "correctness": "container-reviewer-ue",
      "decomp": "container-decomposition-reviewer-ue"
    }
  }
  ```
  The agent basenames must match files in [`dynamic-agents/`](./../dynamic-agents/) (the server compiles them to `.compiled-agents/` on demand).
- Restart the coordination server so it re-reads `scaffold.config.json`.

**Verification:**
- `curl http://localhost:9100/config/<projectId> | jq .agentRoles` returns the populated map (not `null`, not `{}`).
- End-to-end FSM smoke: author one trivial single-phase task, launch one container, watch it traverse the full FSM. Confirm in the container log that the engineer phase launches `container-implementer-ue`, the reviewing phase fans out three parallel reviewers each with their configured basename, and (if exercised by a deliberate contradiction) the arbitrator phase launches `container-arbitrator-ue`.
