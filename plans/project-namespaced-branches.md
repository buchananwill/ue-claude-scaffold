# Project-Namespaced Branch Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Namespace all `docker/` branches by project ID so that two projects sharing the same bare repo cannot collide on branch names.

**Architecture:** Replace the flat `docker/{agent-name}` and `docker/current-root` patterns with `docker/{project-id}/{agent-name}` and `docker/{project-id}/current-root` throughout shell scripts, server routes, tests, config, and documentation. Centralise the naming convention in a single server-side helper module. Shell scripts compute the same pattern inline using `$PROJECT_ID`.

**Tech Stack:** Bash (launch.sh, setup.sh), TypeScript/Fastify (server routes), Node.js built-in test runner.

---

## Problem

Two projects can share the same bare repo (e.g. `piste-perfect` and `content-catalogue-dashboard` both point at `bare-repos/piste-perfect-ue-alpha.git`). Today, both resolve to `docker/agent-1` and `docker/current-root` by default, so launching containers for both projects simultaneously would have them writing to the same branches.

## Naming Convention

| Current | New |
|---------|-----|
| `docker/current-root` | `docker/{project-id}/current-root` |
| `docker/{agent-name}` | `docker/{project-id}/{agent-name}` |

The `planBranch` config field already allows explicit override per project. After this change, the *default* when `planBranch` is unset shifts from `docker/current-root` to `docker/{project-id}/current-root`. Explicit `planBranch` values are used as-is (no automatic migration).

## File Structure

### New files
- **`server/src/branch-naming.ts`** - Two pure functions: `planBranchFor(projectId, config?)` and `agentBranchFor(projectId, agentName)`. Single source of truth for the naming convention on the server side.
- **`server/src/branch-naming.test.ts`** - Unit tests for the helpers.

### Modified files (server routes - mechanical replacement)
- **`server/src/routes/agents.ts:184-185`** - Sync endpoint: replace inline `docker/current-root` fallback and `` `docker/${name}` `` with helpers.
- **`server/src/routes/build.ts:169`** - `syncWorktree` fallback: replace `'docker/current-root'` with `planBranchFor(projectId)`, threading `projectId` from `resolveProjectIdForAgent`.
- **`server/src/routes/sync.ts:52,81`** - Plan sync: replace fallback and agent branch construction with helpers.
- **`server/src/routes/tasks.ts:85,164,167,283,490`** - Task creation/claiming: replace all `'docker/current-root'` fallbacks and `` `docker/${agentName}` `` constructions with helpers.
- **`server/src/routes/tasks-files.ts:121`** - File operations: replace fallback with helper.
- **`server/src/routes/tasks-lifecycle.ts:63`** - Lifecycle: replace fallback with helper.
- **`server/src/routes/tasks-claim.ts:46,48`** - Claiming: replace fallbacks with helper.

### Modified files (server tests)
- **`server/src/routes/build.test.ts`** - Update branch strings in test setup and assertions.
- **`server/src/routes/agents.test.ts`** - Update branch strings in test setup and assertions.
- **`server/src/routes/tasks.test.ts`** - Update branch strings in test setup and assertions.

### Modified files (shell scripts)
- **`launch.sh:249-251`** - Branch construction: `AGENT_BRANCH="docker/${PROJECT_ID}/${AGENT_NAME}"`, `ROOT_BRANCH` default to `"docker/${PROJECT_ID}/current-root"`.
- **`launch.sh:419`** - Parallel mode display.
- **`launch.sh:530`** - Team member branch: `_MEMBER_BRANCH="docker/${PROJECT_ID}/${_MEMBER_NAME}"`.
- **`launch.sh:737-743`** - Parallel branch creation.
- **`setup.sh:123-155`** - Initial branch creation: iterate projects, create `docker/{id}/current-root` per project.

### Modified files (config/docs)
- **`scaffold.config.example.json`** - Update `planBranch` and `defaultBranch` examples.
- **`CLAUDE.md`** - Update branch model diagrams and descriptions.
- **`README.md`** - Update branch documentation.
- **`skills/container-git-*/SKILL.md`** (4 files) - Update branch examples.

### Unchanged files (receive branch as env var, no construction)
- `container/entrypoint.sh` - Uses `$WORK_BRANCH` as-is.
- `container/hooks/guard-branch.sh` - Uses `$WORK_BRANCH` as-is.
- `container/hooks/push-after-commit.sh` - Uses `$WORK_BRANCH` as-is.

---

## Task 1: Branch-naming helper module

**Files:**
- Create: `server/src/branch-naming.ts`
- Create: `server/src/branch-naming.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// server/src/branch-naming.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planBranchFor, agentBranchFor } from './branch-naming.js';

describe('planBranchFor', () => {
  it('returns docker/{projectId}/current-root when no override', () => {
    assert.equal(planBranchFor('piste-perfect'), 'docker/piste-perfect/current-root');
  });

  it('returns explicit planBranch when provided', () => {
    assert.equal(
      planBranchFor('piste-perfect', { planBranch: 'custom/branch' }),
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/branch-naming.test.ts`
Expected: FAIL with "Cannot find module './branch-naming.js'"

- [ ] **Step 3: Write implementation**

```ts
// server/src/branch-naming.ts

/**
 * Compute the plan/integration branch for a project.
 * If the project config specifies an explicit planBranch, use it;
 * otherwise derive from the project ID.
 */
export function planBranchFor(
  projectId: string,
  projectConfig?: { planBranch?: string },
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/branch-naming.test.ts`
Expected: 5 passing tests

- [ ] **Step 5: Commit**

```bash
git add server/src/branch-naming.ts server/src/branch-naming.test.ts
git commit -m "feat: add branch-naming helpers for project-namespaced branches"
```

---

## Task 2: Update server routes to use helpers

Each route file currently has inline `'docker/current-root'` fallbacks and `` `docker/${name}` `` constructions. Replace them all with the helpers from Task 1. Every route already has `projectId` available (via `X-Project-Id` header or `resolveProjectIdForAgent`).

**Files:**
- Modify: `server/src/routes/agents.ts:184-185`
- Modify: `server/src/routes/build.ts:165-175`
- Modify: `server/src/routes/sync.ts:52,81`
- Modify: `server/src/routes/tasks.ts:85,164,167,283,490`
- Modify: `server/src/routes/tasks-files.ts:121`
- Modify: `server/src/routes/tasks-lifecycle.ts:63`
- Modify: `server/src/routes/tasks-claim.ts:46,48`

- [ ] **Step 1: Update `agents.ts`**

Add import at top:
```ts
import { planBranchFor, agentBranchFor } from '../branch-naming.js';
```

Replace lines 184-185:
```ts
// Before:
const planBranch = project.planBranch ?? 'docker/current-root';
const targetBranch = `docker/${name}`;

// After:
const planBranch = planBranchFor(projectId, project);
const targetBranch = agentBranchFor(projectId, name);
```

Note: the sync endpoint needs `projectId`. It is extracted from the agent's registration. Read the route to confirm how `project` is resolved and ensure `projectId` is in scope. If only `project` is available (from `getProject`), thread `projectId` from the route param lookup or the agent's `project_id` column.

- [ ] **Step 2: Update `build.ts`**

Add import at top:
```ts
import { planBranchFor } from '../branch-naming.js';
```

In `syncWorktree` (line 169), the function already receives `project` and the caller has `projectId`. Thread `projectId` into `syncWorktree` as a parameter:

```ts
// Before:
async function syncWorktree(agentName: string | undefined, project: ProjectConfig): Promise<'changed' | 'unchanged'> {
  // ...
  let branch = 'docker/current-root';
  if (agentName) {
    const agentRow = await agentsQ.getWorktreeInfo(getDb(), agentName);
    if (agentRow?.worktree) {
      branch = agentRow.worktree;
    }
  }

// After:
async function syncWorktree(agentName: string | undefined, project: ProjectConfig, projectId: string): Promise<'changed' | 'unchanged'> {
  // ...
  let branch = planBranchFor(projectId, project);
  if (agentName) {
    const agentRow = await agentsQ.getWorktreeInfo(getDb(), agentName);
    if (agentRow?.worktree) {
      branch = agentRow.worktree;
    }
  }
```

Update both call sites (`/build` and `/test` handlers) to pass `projectId` (already in scope from `resolveProjectIdForAgent`).

- [ ] **Step 3: Update `sync.ts`**

Add import at top:
```ts
import { planBranchFor, agentBranchFor } from '../branch-naming.js';
```

Replace line 52:
```ts
// Before:
const planBranch = project.planBranch ?? config.tasks?.planBranch ?? 'docker/current-root';

// After:
const planBranch = planBranchFor(projectId, project);
```

Note: if `config.tasks?.planBranch` was a secondary fallback, decide whether to preserve it. Since per-project config should take priority and the helper handles the default, the `config.tasks?.planBranch` fallback can be dropped (it was a legacy top-level field). If preserving it matters, pass it as: `planBranchFor(projectId, { planBranch: project.planBranch ?? config.tasks?.planBranch })`.

Replace line 81:
```ts
// Before:
const targetBranch = `docker/${agentName}`;

// After:
const targetBranch = agentBranchFor(projectId, agentName);
```

- [ ] **Step 4: Update `tasks.ts`**

Add import at top:
```ts
import { planBranchFor, agentBranchFor } from '../branch-naming.js';
```

Apply the same pattern at each of the 5 locations (lines 85, 164, 167, 283, 490):
- Replace `project.planBranch ?? config.tasks?.planBranch ?? 'docker/current-root'` with `planBranchFor(projectId, project)`
- Replace `` `docker/${agentName}` `` with `agentBranchFor(projectId, agentName)`

- [ ] **Step 5: Update `tasks-files.ts`, `tasks-lifecycle.ts`, `tasks-claim.ts`**

Same pattern in each file: add import, replace `'docker/current-root'` fallbacks with `planBranchFor(projectId, project)`. Each of these routes already has `projectId` in scope (check and thread if needed).

- [ ] **Step 6: Run full test suite**

Run: `cd server && npm test`
Expected: Tests will FAIL because test setup still uses old branch names. That's correct. Confirm only branch-name-related assertions fail, no other breakage.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/agents.ts server/src/routes/build.ts server/src/routes/sync.ts \
  server/src/routes/tasks.ts server/src/routes/tasks-files.ts server/src/routes/tasks-lifecycle.ts \
  server/src/routes/tasks-claim.ts
git commit -m "refactor: use branch-naming helpers in all server routes"
```

---

## Task 3: Update server tests

**Files:**
- Modify: `server/src/routes/build.test.ts`
- Modify: `server/src/routes/agents.test.ts`
- Modify: `server/src/routes/tasks.test.ts`

- [ ] **Step 1: Update `agents.test.ts`**

The test creates branches and checks merge behavior. Update all branch references:

```ts
// Before:
initBareRepoWithBranch(tmpDir, 'docker/current-root');
execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/test-agent ${initSha}`);
planBranch: 'docker/current-root'

// After (assuming test project ID is 'default' or whatever the test config uses):
initBareRepoWithBranch(tmpDir, 'docker/default/current-root');
execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/default/test-agent ${initSha}`);
planBranch: 'docker/default/current-root'
```

Check what `projectId` the test config resolves to and use that consistently. If the test config sets a specific project ID, use it; otherwise `'default'`.

Also update the test title string:
```ts
// Before:
'merges docker/current-root into docker/{name}'

// After:
'merges docker/{projectId}/current-root into docker/{projectId}/{name}'
```

- [ ] **Step 2: Update `build.test.ts`**

Update branch strings in test assertions and setup:

```ts
// Before:
'defaults to docker/current-root when no agent is registered'
// assertion checking stderr mentions docker/current-root

// After:
'defaults to docker/{projectId}/current-root when no agent is registered'
// assertion checking stderr mentions docker/{projectId}/current-root
```

Update test agent worktree values:
```ts
// Before:
worktree: 'docker/test-agent'

// After:
worktree: 'docker/default/test-agent'
```

- [ ] **Step 3: Update `tasks.test.ts`**

Same pattern: update `initBareRepoWithBranch` calls and `update-ref` commands to use namespaced branch names.

```ts
// Before:
initBareRepoWithBranch(tmpDir, 'docker/current-root');
`update-ref refs/heads/docker/agent-1 ${initSha}`
`update-ref refs/heads/docker/agent-2 ${initSha}`
planBranch: 'docker/current-root'

// After:
initBareRepoWithBranch(tmpDir, 'docker/default/current-root');
`update-ref refs/heads/docker/default/agent-1 ${initSha}`
`update-ref refs/heads/docker/default/agent-2 ${initSha}`
planBranch: 'docker/default/current-root'
```

- [ ] **Step 4: Run full test suite**

Run: `cd server && npm test`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/build.test.ts server/src/routes/agents.test.ts server/src/routes/tasks.test.ts
git commit -m "test: update branch names in tests for project-namespaced convention"
```

---

## Task 4: Update `launch.sh`

**Files:**
- Modify: `launch.sh:28,37,249-251,419,530,737-743`

- [ ] **Step 1: Update branch construction (line 249-251)**

```bash
# Before:
AGENT_BRANCH="docker/${AGENT_NAME}"
ROOT_BRANCH="${ROOT_BRANCH:-docker/current-root}"
WORK_BRANCH="$AGENT_BRANCH"

# After:
AGENT_BRANCH="docker/${PROJECT_ID}/${AGENT_NAME}"
ROOT_BRANCH="${ROOT_BRANCH:-docker/${PROJECT_ID}/current-root}"
WORK_BRANCH="$AGENT_BRANCH"
```

This depends on `PROJECT_ID` being set before this point. Verify from the earlier read: `PROJECT_ID` is resolved at line ~155 (from `--project` CLI arg or `.env`), well before line 249. Confirmed safe.

- [ ] **Step 2: Update team member branch (line 530)**

```bash
# Before:
_MEMBER_BRANCH="docker/${_MEMBER_NAME}"

# After:
_MEMBER_BRANCH="docker/${PROJECT_ID}/${_MEMBER_NAME}"
```

- [ ] **Step 3: Update parallel mode branch creation (lines 737-743)**

Find the loop that creates `docker/agent-N` branches and update:

```bash
# Before (approximate):
docker/agent-${i}

# After:
docker/${PROJECT_ID}/agent-${i}
```

- [ ] **Step 4: Update display/help strings**

Update the help text (line 28) and parallel mode display (line 419) to reflect the new pattern:

```bash
# Line 28:
--fresh             Reset agent branch to docker/{project}/{agent} HEAD (clean start)

# Line 37:
Branch is docker/{project}/{agent-name}, forked from docker/{project}/current-root.

# Line 419:
echo "  agent-${i} -> docker/${PROJECT_ID}/agent-${i}"
```

- [ ] **Step 5: Validate syntax**

Run: `bash -n launch.sh`
Expected: No output (clean parse)

- [ ] **Step 6: Dry-run smoke test**

Run: `./launch.sh --project content-catalogue-dashboard --dry-run`
Expected: Output shows `AGENT_BRANCH: docker/content-catalogue-dashboard/agent-1` and `ROOT_BRANCH: docker/content-catalogue-dashboard/current-root`.

- [ ] **Step 7: Commit**

```bash
git add launch.sh
git commit -m "refactor: namespace agent branches by project ID in launch.sh"
```

---

## Task 5: Update `setup.sh`

**Files:**
- Modify: `setup.sh:123-155`

- [ ] **Step 1: Update `ensure_bare_repo` to create project-namespaced branches**

The function currently creates `docker/current-root` for every bare repo. It needs to create `docker/{project-id}/current-root` instead. The function is called with a project path and bare path, but needs the project ID too.

Check how `ensure_bare_repo` is called. It iterates the `projects` map from config. Thread the project ID (the map key) into the function:

```bash
# In the caller (the loop over projects):
# Before:
ensure_bare_repo "$proj_path" "$bare_path" "$label"

# After:
ensure_bare_repo "$proj_path" "$bare_path" "$label" "$proj_id"

# In the function:
# Add parameter:
local proj_id="${4:-default}"

# Replace all occurrences of:
refs/heads/docker/current-root
# With:
refs/heads/docker/${proj_id}/current-root

# Replace all display strings:
# "docker/current-root" -> "docker/${proj_id}/current-root"
```

Note: multiple projects may share a bare repo. Each call creates its own namespaced branch. The function is called once per project entry, so `docker/piste-perfect/current-root` and `docker/content-catalogue-dashboard/current-root` both get created in the same bare repo. This is correct.

- [ ] **Step 2: Update the "branch missing" warning**

```bash
# Before:
echo "  Warning: docker/current-root branch missing. Create it:"
echo "    git -C $bare branch docker/current-root HEAD"

# After:
echo "  Warning: docker/${proj_id}/current-root branch missing. Create it:"
echo "    git -C $bare branch docker/${proj_id}/current-root HEAD"
```

- [ ] **Step 3: Validate syntax**

Run: `bash -n setup.sh`
Expected: No output (clean parse)

- [ ] **Step 4: Commit**

```bash
git add setup.sh
git commit -m "refactor: namespace initial branch creation by project ID in setup.sh"
```

---

## Task 6: Migration path for existing bare repos

Existing bare repos have `docker/current-root` and `docker/agent-*` branches. After this change, launches expect `docker/{project-id}/current-root`. We need a one-time migration.

**Files:**
- Modify: `setup.sh` (add migration logic to `ensure_bare_repo`)

- [ ] **Step 1: Add migration detection and branch copying**

In `ensure_bare_repo`, after checking that the bare repo exists, detect old-style branches and offer to copy them:

```bash
# After the existing "Bare repo already exists" block:
if git -C "$bare" rev-parse --verify "refs/heads/docker/current-root" &>/dev/null; then
  if ! git -C "$bare" rev-parse --verify "refs/heads/docker/${proj_id}/current-root" &>/dev/null; then
    if [[ "$NON_INTERACTIVE" == true ]]; then
      echo "  Migrating docker/current-root -> docker/${proj_id}/current-root"
      local old_sha
      old_sha=$(git -C "$bare" rev-parse "refs/heads/docker/current-root")
      git -C "$bare" update-ref "refs/heads/docker/${proj_id}/current-root" "$old_sha"
    else
      read -rp "  Migrate docker/current-root -> docker/${proj_id}/current-root? [y/N] " _mig
      if [[ "${_mig,,}" == "y" ]]; then
        local old_sha
        old_sha=$(git -C "$bare" rev-parse "refs/heads/docker/current-root")
        git -C "$bare" update-ref "refs/heads/docker/${proj_id}/current-root" "$old_sha"
        echo "  Migrated."
      fi
    fi
  fi
fi
```

This copies (not renames) the old branch, so the old `docker/current-root` still exists. It can be cleaned up later. This is safe because two projects sharing a repo will each get their own copy from the same source.

- [ ] **Step 2: Validate syntax**

Run: `bash -n setup.sh`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add setup.sh
git commit -m "feat: add migration from flat docker/ branches to project-namespaced"
```

---

## Task 7: Update config examples and documentation

**Files:**
- Modify: `scaffold.config.example.json`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `skills/container-git-write/SKILL.md`
- Modify: `skills/container-git-environment/SKILL.md`
- Modify: `skills/container-git-readonly/SKILL.md`
- Modify: `skills/container-git-build-intercept/SKILL.md`
- Modify: `skills/cleanup-session-protocol/SKILL.md`

- [ ] **Step 1: Update `scaffold.config.example.json`**

```json
// Before:
"planBranch": "docker/current-root"
"defaultBranch": "docker/current-root"

// After:
"planBranch": "docker/my-ue-game/current-root"
"defaultBranch": "docker/my-ue-game/current-root"
```

Add a comment or note that `planBranch` defaults to `docker/{project-id}/current-root` when omitted.

- [ ] **Step 2: Update `CLAUDE.md` branch model diagrams**

Replace the branch model section:

```markdown
### Branch Model

docker/{project-id}/current-root    <- integration branch (user-controlled)
docker/{project-id}/agent-1         <- agent-1's working branch
docker/{project-id}/agent-2         <- agent-2's working branch
```

Update the Git Data Flow diagram similarly.

Update the help text reference for `--fresh`:
```
./launch.sh --fresh --plan path/to/plan.md  # Reset agent branch to docker/{project}/current-root before launch
```

- [ ] **Step 3: Update `README.md`**

Update any branch references to use the namespaced pattern.

- [ ] **Step 4: Update skill files**

In each of the 5 skill files, replace:
- `docker/{agent-name}` with `docker/{project-id}/{agent-name}`
- `docker/current-root` with `docker/{project-id}/current-root`
- Example commands like `git show docker/agent-2:path/to/file.ts` with `git show docker/my-project/agent-2:path/to/file.ts`
- `git log docker/current-root` with `git log docker/my-project/current-root`

- [ ] **Step 5: Commit**

```bash
git add scaffold.config.example.json CLAUDE.md README.md skills/
git commit -m "docs: update branch naming to project-namespaced convention"
```

---

## Edge Cases and Design Decisions

1. **Legacy `config.tasks.planBranch` fallback**: Several routes chain `project.planBranch ?? config.tasks?.planBranch ?? 'docker/current-root'`. The middle fallback (`config.tasks?.planBranch`) is a legacy top-level field. With per-project namespacing, this legacy fallback is ambiguous (which project?). Decision: drop it from the chain. Routes use `planBranchFor(projectId, project)` which only checks `project.planBranch`, then falls back to the computed default. If anyone still uses the legacy top-level `tasks.planBranch`, they should migrate it to per-project config.

2. **`ROOT_BRANCH` env var override**: `launch.sh` allows `ROOT_BRANCH` to be set explicitly in `.env`. The new default changes but the override still works: `ROOT_BRANCH="${ROOT_BRANCH:-docker/${PROJECT_ID}/current-root}"`. Anyone who set `ROOT_BRANCH=docker/current-root` explicitly in `.env` keeps that value.

3. **Container scripts unchanged**: `entrypoint.sh`, `guard-branch.sh`, and `push-after-commit.sh` all use `$WORK_BRANCH` as an opaque value. Since `launch.sh` now sets `WORK_BRANCH="docker/${PROJECT_ID}/${AGENT_NAME}"`, these scripts work without modification.

4. **Agent DB `worktree` column**: Already stores the full branch path. After this change, newly registered agents store `docker/{project-id}/{agent-name}`. Old registrations retain `docker/{agent-name}`. The `syncWorktree` function in `build.ts` uses the stored value when an agent is registered, only falling back to the plan branch helper when no agent is found. This is correct.

5. **Old branches not deleted**: The migration in Task 6 copies branches, not renames. Old `docker/current-root` and `docker/agent-*` branches persist. They can be cleaned up manually or in a follow-up script. This avoids breaking any in-flight containers.
