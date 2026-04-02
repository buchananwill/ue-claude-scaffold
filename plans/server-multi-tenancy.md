# Plan: Server Multi-Tenancy and Project-Namespaced Branches

**Goal:** Make the server a fully multi-tenant system: project config lives in the database (not JSON), all branches are
namespaced by project ID, and shell scripts respect the new naming convention.

**Tech Stack:** TypeScript/Fastify (server), Drizzle ORM + PGlite (DB), Bash (shell scripts), Node.js built-in test
runner.

---

## Context

Two concerns converge here:

1. **Split authority** - Project configuration lives in `scaffold.config.json` (`resolvedProjects`) while all other
   server state lives in the database. The DB should be the single authority for project definitions.
2. **Branch collision** - Two projects sharing a bare repo both resolve to `docker/current-root` and `docker/agent-1`.
   Launching containers for both simultaneously has them writing to the same branches. Branches must be namespaced:
   `docker/{project-id}/current-root`, `docker/{project-id}/{agent-name}`.

These are tackled in order: first unify project config into the DB, then namespace branches using the project IDs that
are now first-class entities.

---

## Phase 1: Projects Table and CRUD

**Goal:** Move project configuration from JSON into the database. Make the DB the single source of truth for project
identity and configuration.

### 1.1 New `projects` Table

Add a Drizzle table for project configuration:

```
projects
  id           text PK        (validated: [a-zA-Z0-9_-]{1,64})
  name         text NOT NULL
  path         text NOT NULL   (host project path)
  uproject_file text
  bare_repo_path text NOT NULL
  tasks_path   text
  plan_branch  text
  engine_path  text
  engine_version text
  build_script_path text
  test_script_path text
  build_timeout_ms integer
  test_timeout_ms integer
  staging_worktree_root text
  staging_copies jsonb         (array of {source, relativeDest})
  created_at   timestamp DEFAULT now()
```

This mirrors the existing `ProjectConfig` interface (`server/src/config.ts:4-15`).

**Files:**

- Modify: `server/src/schema/tables.ts`

### 1.2 Seed from JSON Config

On server startup, seed the `projects` table from `resolvedProjects` in the JSON config using INSERT-only semantics:

- If a project ID from JSON does **not** exist in the DB: insert it.
- If a project ID from JSON **already** exists in the DB: validate that the JSON config matches the DB record. Log an
  error if they diverge (but don't overwrite). Skip the insert.

JSON + boot is a convenience path for initializing a new DB without manual API calls. Changes to existing projects must
go through the API endpoints.

**Files:**

- Modify: `server/src/index.ts` (or wherever startup hooks live)
- New: `server/src/queries/projects.ts`

### 1.3 Project CRUD Endpoints

```
GET    /projects              - list all projects
GET    /projects/:id          - get single project config
POST   /projects              - create a new project
PATCH  /projects/:id          - update project config
DELETE /projects/:id          - reject with 409 if any data exists for this project
```

**Files:**

- New: `server/src/routes/projects.ts`

### 1.4 Refactor `getProject()` and Route Handlers

- `getProject(config, id)` (`server/src/config.ts:251`) currently reads from `config.resolvedProjects`. This becomes a
  DB query.
- Routes that use `request.projectId` (from the `project-id` plugin) should validate the project exists in the DB, not
  in config.
- The `project-id` plugin (`server/src/plugins/project-id.ts`) should validate against DB and attach the full project
  record to the request (not just the string ID).

**Files:**

- Modify: `server/src/config.ts`
- Modify: `server/src/plugins/project-id.ts`

### 1.5 Simplify `scaffold.config.json`

After this change, the JSON config retains only server-level concerns:

- `server.port`
- `server.ubtLockTimeoutMs`
- PGlite data directory (if applicable)
- Any other host-level settings not scoped to a project

Project-specific fields (`project.*`, `engine.*`, `build.*`, `tasks.*`, `plugins.*`) move to the DB. The legacy format
is still accepted for initial seeding but is not the runtime authority.

**Files:**

- Modify: `server/src/config.ts` (strip project-specific types from JSON config interface)
- Modify: `scaffold.config.example.json`

### 1.6 Health Endpoint Update

`GET /health` currently returns `config.projectName` from the JSON. Either:

- Drop project info from health (it's a server-level endpoint), or
- Accept `x-project-id` and return that project's name from the DB

**Files:**

- Modify: `server/src/routes/health.ts`

### 1.7 Tests for Phase 1

Write tests for the new projects CRUD endpoints and the seed-from-JSON behaviour.

**Files:**

- New: `server/src/routes/projects.test.ts`

### Design Decisions (Phase 1)

- **Delete semantics:** `DELETE /projects/:id` returns 409 Conflict if any agents, tasks, messages, builds, or other
  data exist for that project. User must clean up associated data first.
- **JSON seed behaviour:** INSERT-only, not upsert. Validate-and-warn on conflict. JSON is a convenience for DB
  initialization, not the runtime authority.
- **Config scope:** Full `ProjectConfig` in the DB (all build/engine/plugin fields). DB is the single authority for
  everything project-specific.
- **Hot reload:** DB-backed config naturally supports hot changes without server restart, which is an advantage over
  JSON.

---

## Phase 2: Branch-Naming Helper Module

**Goal:** Centralise the branch naming convention in a single server-side module. All subsequent phases depend on this.

### Naming Convention

| Current               | New                                |
|-----------------------|------------------------------------|
| `docker/current-root` | `docker/{project-id}/current-root` |
| `docker/{agent-name}` | `docker/{project-id}/{agent-name}` |

The `planBranch` config field (now a column in the `projects` table) allows explicit override. When unset, the default
shifts from `docker/current-root` to `docker/{project-id}/current-root`. Explicit `planBranch` values are used as-is.

### 2.1 Write Failing Tests

**Files:**

- Create: `server/src/branch-naming.test.ts`

```ts
// server/src/branch-naming.test.ts
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {planBranchFor, agentBranchFor} from './branch-naming.js';

describe('planBranchFor', () => {
    it('returns docker/{projectId}/current-root when no override', () => {
        assert.equal(planBranchFor('piste-perfect'), 'docker/piste-perfect/current-root');
    });

    it('returns explicit planBranch when provided', () => {
        assert.equal(
            planBranchFor('piste-perfect', {planBranch: 'custom/branch'}),
            'custom/branch',
        );
    });

    it('works with default project id', () => {
        assert.equal(planBranchFor('default'), 'docker/default/current-root');
    });
});

describe('agentBranchFor', () => {
    it('returns docker/{projectId}/{agentName}', () => {
        assert.equal(agentBranchFor('piste-perfect', 'agent-1'), 'docker/piste-perfect/agent-1');
    });

    it('works with default project id', () => {
        assert.equal(agentBranchFor('default', 'agent-1'), 'docker/default/agent-1');
    });
});
```

### 2.2 Write Implementation

**Files:**

- Create: `server/src/branch-naming.ts`

```ts
// server/src/branch-naming.ts

/**
 * Compute the plan/integration branch for a project.
 * If the project config specifies an explicit planBranch, use it;
 * otherwise derive from the project ID.
 */
export function planBranchFor(
    projectId: string,
    projectConfig?: { planBranch?: string | null },
): string {
    return projectConfig?.planBranch ?? `docker/${projectId}/current-root`;
}

/**
 * Compute the working branch for a specific agent within a project.
 */
export function agentBranchFor(projectId: string, agentName: string): string {
    return `docker/${projectId}/${agentName}`;
}
```

### 2.3 Run Tests

Run: `cd server && npx tsx --test src/branch-naming.test.ts`
Expected: 5 passing tests.

---

## Phase 3: Update Server Routes to Use Helpers

Each route file currently has inline `'docker/current-root'` fallbacks and `` `docker/${name}` `` constructions. Replace
them all with the helpers from Phase 2. Every route already has `projectId` available (via `X-Project-Id` header or
`resolveProjectIdForAgent`).

After Phase 1, `getProject()` returns a DB record. The `planBranch` field is now a column on that record, so
`planBranchFor(projectId, project)` reads `project.planBranch` from the DB row.

### 3.1 Update `agents.ts`

Add import, replace lines 184-185:

```ts
const planBranch = planBranchFor(projectId, project);
const targetBranch = agentBranchFor(projectId, name);
```

**Files:** `server/src/routes/agents.ts`

### 3.2 Update `build.ts`

Thread `projectId` into `syncWorktree` as a parameter. Replace `'docker/current-root'` fallback with
`planBranchFor(projectId, project)`.

**Files:** `server/src/routes/build.ts`

### 3.3 Update `sync.ts`

Replace `project.planBranch ?? config.tasks?.planBranch ?? 'docker/current-root'` with
`planBranchFor(projectId, project)`. Drop the legacy `config.tasks?.planBranch` fallback (ambiguous in multi-project
context). Replace `` `docker/${agentName}` `` with `agentBranchFor(projectId, agentName)`.

**Files:** `server/src/routes/sync.ts`

### 3.4 Update `tasks.ts`

Same pattern at each location (lines 85, 164, 167, 283, 490):

- `planBranchFor(projectId, project)` replaces plan branch fallbacks
- `agentBranchFor(projectId, agentName)` replaces inline construction

**Files:** `server/src/routes/tasks.ts`

### 3.5 Update `tasks-files.ts`, `tasks-lifecycle.ts`, `tasks-claim.ts`

Same pattern: add import, replace `'docker/current-root'` fallbacks with `planBranchFor(projectId, project)`.

**Files:**

- `server/src/routes/tasks-files.ts`
- `server/src/routes/tasks-lifecycle.ts`
- `server/src/routes/tasks-claim.ts`

---

## Phase 4: Update Server Tests

Update all branch string references in existing tests to use the namespaced convention.

### 4.1 Update `agents.test.ts`

Replace:

- `initBareRepoWithBranch(tmpDir, 'docker/current-root')` with `'docker/default/current-root'`
- `refs/heads/docker/test-agent` with `refs/heads/docker/default/test-agent`
- Related assertions and display strings

**Files:** `server/src/routes/agents.test.ts`

### 4.2 Update `build.test.ts`

Replace branch strings in assertions and test agent worktree values.

**Files:** `server/src/routes/build.test.ts`

### 4.3 Update `tasks.test.ts`

Replace `initBareRepoWithBranch` calls and `update-ref` commands.

**Files:** `server/src/routes/tasks.test.ts`

### 4.4 Run Full Test Suite

Run: `cd server && npm test`
Expected: ALL tests pass.

---

## Phase 5: Update Shell Scripts

### 5.1 Update `launch.sh`

Branch construction (line 249-251):

```bash
AGENT_BRANCH="docker/${PROJECT_ID}/${AGENT_NAME}"
ROOT_BRANCH="${ROOT_BRANCH:-docker/${PROJECT_ID}/current-root}"
WORK_BRANCH="$AGENT_BRANCH"
```

Team member branch (line 530):

```bash
_MEMBER_BRANCH="docker/${PROJECT_ID}/${_MEMBER_NAME}"
```

Parallel mode branch creation (lines 737-743): update loop to use `docker/${PROJECT_ID}/agent-${i}`.

Update help text and display strings to reflect the new pattern.

Validate: `bash -n launch.sh`
Smoke test: `./launch.sh --project content-catalogue-dashboard --dry-run`

**Files:** `launch.sh`

### 5.2 Update `setup.sh`

Update `ensure_bare_repo` to accept project ID as a parameter and create `docker/{project-id}/current-root` instead of
`docker/current-root`.

Multiple projects sharing a bare repo each get their own namespaced branch (one call per project entry).

Update warning messages to reflect namespaced branch names.

Validate: `bash -n setup.sh`

**Files:** `setup.sh`

### 5.3 Migration Path for Existing Bare Repos

In `ensure_bare_repo`, after checking that the bare repo exists, detect old-style `docker/current-root` branches and
copy them to `docker/{project-id}/current-root`:

- Non-interactive mode: auto-migrate with a log message.
- Interactive mode: prompt user for confirmation.
- Copy (not rename) so old branches persist for in-flight containers.

**Files:** `setup.sh`

---

## Phase 6: Update Config Examples and Documentation

### 6.1 `scaffold.config.example.json`

Update `planBranch` and `defaultBranch` examples to `docker/{project-id}/current-root`.

### 6.2 `CLAUDE.md`

Update the branch model section and Git Data Flow diagram:

```
docker/{project-id}/current-root    <- integration branch (user-controlled)
docker/{project-id}/agent-1         <- agent-1's working branch
docker/{project-id}/agent-2         <- agent-2's working branch
```

Update `--fresh` description.

### 6.3 Skill Files

In each container-git skill and `cleanup-session-protocol`, replace:

- `docker/{agent-name}` with `docker/{project-id}/{agent-name}`
- `docker/current-root` with `docker/{project-id}/current-root}`

**Files:**

- `scaffold.config.example.json`
- `CLAUDE.md`
- `README.md`
- `skills/container-git-write/SKILL.md`
- `skills/container-git-environment/SKILL.md`
- `skills/container-git-readonly/SKILL.md`
- `skills/container-git-build-intercept/SKILL.md`
- `skills/cleanup-session-protocol/SKILL.md`

---

## Edge Cases and Design Decisions

1. **Legacy `config.tasks.planBranch` fallback**: Several routes chain
   `project.planBranch ?? config.tasks?.planBranch ?? 'docker/current-root'`. The middle fallback is a legacy top-level
   field. With per-project namespacing, it's ambiguous. Decision: drop it. Routes use
   `planBranchFor(projectId, project)` which checks the project's DB record, then falls back to the computed default.

2. **`ROOT_BRANCH` env var override**: `launch.sh` allows `ROOT_BRANCH` to be set explicitly in `.env`. The new default
   changes but the override still works: `ROOT_BRANCH="${ROOT_BRANCH:-docker/${PROJECT_ID}/current-root}"`.

3. **Container scripts unchanged**: `entrypoint.sh`, `guard-branch.sh`, and `push-after-commit.sh` all use
   `$WORK_BRANCH` as an opaque value. Since `launch.sh` now sets `WORK_BRANCH="docker/${PROJECT_ID}/${AGENT_NAME}"`,
   these scripts work without modification.

4. **Agent DB `worktree` column**: Already stores the full branch path. Newly registered agents store
   `docker/{project-id}/{agent-name}`. Old registrations retain `docker/{agent-name}`. The `syncWorktree` function uses
   the stored value when an agent is registered, only falling back to the plan branch helper when no agent is found.

5. **Old branches not deleted**: The migration copies branches, not renames. Old `docker/current-root` and
   `docker/agent-*` branches persist for safety. Clean up manually or via a follow-up script.

6. **Delete semantics for projects**: `DELETE /projects/:id` returns 409 Conflict if any agents, tasks, messages,
   builds, or other data exist for that project.

7. **JSON seed behaviour**: INSERT-only, not upsert. Validate-and-warn on conflict.
