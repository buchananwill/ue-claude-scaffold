# Promote-with-Auto-Sync: Task Creation from Any Worktree

## Context

Interactive Claude sessions run in project worktrees (e.g. `PistePerfect_5_7`, `claude_work`). Plans
are written and committed there. Container workers read plans from the bare repo's
`docker/current-root` branch. Today, promoting a committed plan to a task requires the plan to
already exist in the bare repo — if it doesn't, the `POST /tasks` call fails with a 422.

This creates friction: the interactive session must manually push commits to the bare repo before
creating a task. The server has all the information it needs to do this automatically.

### Goal

When `POST /tasks` receives a `sourcePath` that doesn't exist in the bare repo, the server should
look for the file in a worktree, read it, commit it to the bare repo, and create the task — all in
one call. The interactive Claude sends one POST and the plan is promoted.

### Depends on

v0.2.0 (single bare repo). The logic references `config.server.bareRepoPath` as a single path.

---

## Phase 1 — Add `sourceWorktree` parameter to `POST /tasks`

**Files:** `server/src/routes/tasks.ts`

### Changes

Add `sourceWorktree` to `TaskBody`:

```typescript
interface TaskBody {
  title: string;
  description?: string;
  sourcePath?: string;
  sourceContent?: string;
  sourceWorktree?: string;   // NEW — absolute path to a worktree to read sourcePath from
  acceptanceCriteria?: string;
  priority?: number;
  files?: string[];
  targetAgents?: string[];
}
```

Add it to `taskBodyKeys`.

### New resolution logic in `POST /tasks`

Replace the current `sourcePath` validation block with a three-step fallback:

```
if sourceContent is provided:
    → write to bare repo (existing logic, unchanged)

else if sourcePath is provided:
    1. Check bare repo for sourcePath on planBranch
       → if found: done, proceed to task creation

    2. Resolve a worktree to search:
       - Use sourceWorktree if provided
       - Otherwise use config.project.path
       Validate: sourceWorktree must not contain '..' or be empty

    3. Read the file from worktree:
       - Check it exists: fs.existsSync(path.join(worktree, sourcePath))
       - Read contents: fs.readFileSync(path.join(worktree, sourcePath), 'utf-8')
       - Commit to bare repo using writeContentToBareRepo()
       - Proceed to task creation with the resulting commitSha

    4. If file not found in bare repo OR worktree:
       → 422 with message listing where we looked
```

### Path traversal validation

`sourceWorktree` must be an absolute path. Reject if:
- It contains `..`
- It's a relative path
- The resolved `path.join(sourceWorktree, sourcePath)` escapes the worktree root

### Error messages

The 422 response should be specific about where the server looked:

```json
{
  "statusCode": 422,
  "error": "Unprocessable Entity",
  "message": "sourcePath 'Notes/plans/my-plan.md' not found. Searched: bare repo (docker/current-root), worktree (D:/coding/resort_game/PistePerfect_5_7). Commit the file or provide sourceContent."
}
```

### Acceptance criteria

- `POST /tasks` with `sourcePath` that exists in the bare repo works as before (no regression).
- `POST /tasks` with `sourcePath` that exists only in a worktree auto-syncs and succeeds.
- `POST /tasks` with `sourcePath` + explicit `sourceWorktree` reads from that worktree.
- `POST /tasks` with `sourcePath` not found anywhere returns 422 with search locations.
- Path traversal in `sourceWorktree` or `sourcePath` is rejected.
- `npm run typecheck` passes.

---

## Phase 2 — Apply the same logic to `POST /tasks/batch`

**Files:** `server/src/routes/tasks.ts`

### Changes

The batch endpoint already validates `sourcePath` per task. Apply the same fallback chain: check
bare repo, then worktree, then auto-sync. The `sourceWorktree` field applies per-task (each task in
the batch can reference a different worktree, though in practice they'll all be the same).

### Acceptance criteria

- Batch creation with mixed `sourceContent` / `sourcePath` / `sourcePath`+`sourceWorktree` works.
- Auto-sync commits are batched where possible (single worktree read pass).
- Existing batch tests still pass.

---

## Phase 3 — Tests

**Files:** `server/src/routes/tasks.test.ts`

### Test cases

1. **sourcePath exists in bare repo** — existing behavior, no worktree lookup.
2. **sourcePath missing from bare repo, found in worktree** — auto-sync, task created, commitSha
   returned.
3. **sourcePath missing from bare repo, found via explicit sourceWorktree** — same as above but
   with the parameter.
4. **sourcePath missing everywhere** — 422 with descriptive message.
5. **sourceWorktree path traversal** — rejected (400).
6. **sourcePath path traversal via sourceWorktree** — rejected (400).
7. **sourceContent takes precedence** — if both sourceContent and sourceWorktree are provided,
   sourceContent wins (existing behavior).

### Acceptance criteria

- All new tests pass.
- Existing task tests still pass.
- `npm test` clean.

---

## Phase 4 — Documentation

**Files:** `D:\coding\resort_game\PistePerfect_5_7\CLAUDE.md`

Update the Task Creation section to document `sourceWorktree`:

```
- `sourceWorktree` — optional absolute path to a worktree. If `sourcePath` isn't in the bare repo,
  the server reads the file from this worktree and commits it automatically. Defaults to the
  project path from scaffold config.
```

### Acceptance criteria

- CLAUDE.md documents `sourceWorktree`.
- The three task creation paths are clear: sourceContent (inline), sourcePath (bare repo or
  auto-synced from worktree), description-only.
