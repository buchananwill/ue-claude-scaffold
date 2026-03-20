# Pull Container Work into Interactive Worktrees

## Context

Container agents push commits to `docker/agent-X` branches in the bare repo. Interactive sessions
work in project worktrees (`PistePerfect_5_7`, `claude_work`, etc.) that point at a separate git
database. There's no return path — the interactive session can't see container commits without
manual git plumbing.

The user works primarily through IDE git integration (not raw git commands), so this needs to
produce branches and history that are visible in the IDE's standard UI.

### Depends on

v0.2.0 (single bare repo at `config.server.bareRepoPath`).

---

## Phase 1 — One-time remote setup

**Where:** The user's main project repo (the `.git` that owns all worktrees).

### What to do

Add the bare repo as a remote named `pipeline`:

```bash
git -C "D:/coding/resort_game/PistePerfect_5_7" remote add pipeline "D:/Coding/resort_game/<bare-repo-path>"
```

The exact path comes from `scaffold.config.json` → `server.bareRepoPath` after v0.2.0 lands.

Remove the stale staging worktree remotes that currently exist:

```bash
git -C "D:/coding/resort_game/PistePerfect_5_7" remote remove agent-1
git -C "D:/coding/resort_game/PistePerfect_5_7" remote remove agent-2
```

### Verify

```bash
git -C "D:/coding/resort_game/PistePerfect_5_7" remote -v
```

Should show `origin` (GitHub) and `pipeline` (bare repo). Nothing else.

### IDE visibility

After adding the remote, the IDE's git panel will show `pipeline/*` remote branches after the
first fetch. No IDE configuration needed — standard git remote tracking.

---

## Phase 2 — Fetch and inspect container work

### Fetch all container branches

```bash
git fetch pipeline
```

This pulls all `docker/*` refs into `pipeline/docker/*` remote-tracking branches. The IDE will
show these in its branch list.

### Inspect a specific agent's work

```bash
git log pipeline/docker/agent-1 --oneline -20
```

Or in the IDE: switch to the `pipeline/docker/agent-1` branch in the branch dropdown.

### Diff against your current state

```bash
git diff HEAD...pipeline/docker/agent-1
```

Or in the IDE: compare branches.

---

## Phase 3 — Merge container work for review

### Create a local review branch

```bash
git checkout -b review/agent-1-work pipeline/docker/agent-1
```

This creates a local branch tracking the container's work. The IDE shows it as a normal local
branch — full diff, file history, blame all work.

### Review and integrate

Option A — **merge into main** (if the work is ready):

```bash
git checkout main
git merge review/agent-1-work
```

Option B — **cherry-pick specific commits**:

```bash
git checkout main
git cherry-pick <commit-sha>
```

Option C — **interactive rebase to clean up** (squash container auto-commits):

```bash
git checkout review/agent-1-work
git rebase -i main
# Squash the "Container auto-commit for build/test" messages
git checkout main
git merge review/agent-1-work
```

### Push reviewed work back to the bare repo

After integrating into `main` (or `docker/current-root`), push so containers see the merged state:

```bash
git push pipeline main:docker/current-root
```

### Clean up

```bash
git branch -d review/agent-1-work
```

---

## Phase 4 — Server endpoint for assisted fetch (optional)

Add a convenience endpoint so the interactive Claude can trigger a fetch without the user running
git commands:

```
POST /pipeline/fetch-status
```

Returns:
```json
{
  "branches": {
    "docker/current-root": { "sha": "abc123", "age": "2 hours ago" },
    "docker/agent-1": { "sha": "def456", "age": "15 minutes ago", "ahead": 7 }
  }
}
```

The `ahead` count is commits ahead of `docker/current-root`. This gives the interactive session
(and the dashboard) visibility into what work is pending review without requiring git commands.

### Acceptance criteria

- Endpoint reads branch refs and commit dates from the bare repo.
- Returns ahead/behind counts relative to `docker/current-root`.
- Dashboard can display this (future work).

---

## Phase 5 — Document the workflow

**Files:** `D:\coding\resort_game\PistePerfect_5_7\CLAUDE.md`, scaffold `CLAUDE.md`

### Add to resort game CLAUDE.md (Workflow section)

```markdown
### Reviewing Container Work

Fetch container branches:
```bash
git fetch pipeline
```

Create a review branch from an agent's work:
```bash
git checkout -b review/agent-1-work pipeline/docker/agent-1
```

After review, merge to main and push back to the bare repo:
```bash
git checkout main
git merge review/agent-1-work
git push pipeline main:docker/current-root
```
```

### Add to scaffold CLAUDE.md (Git Data Flow section)

Update the data flow diagram to show the return path:

```
Container pushes → [bare repo] docker/agent-X
                        ↓
          git fetch pipeline (from interactive worktree)
                        ↓
          review/agent-X-work (local branch)
                        ↓
          merge to main → git push pipeline main:docker/current-root
```

---

## Execution sequence

Phases 1-3 are manual steps performed once v0.2.0 is in place. Phase 4 is an optional server
enhancement. Phase 5 is documentation.

The user and interactive Claude will primarily use Phases 2-3 as a recurring workflow:
fetch → review branch → merge → push back.
