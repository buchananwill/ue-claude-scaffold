# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A scaffold for running autonomous Claude Code agents in Docker containers against Unreal Engine projects. Containers can't install UE, so build/test requests are routed back to the host through a Fastify coordination server that serializes UBT (Unreal Build Tool) access.

## Commands

### Coordination Server (in `server/`)

```bash
npm run dev              # Start dev server with hot reload (tsx watch)
npm run build            # TypeScript compile to dist/
npm run start            # Run compiled server from dist/
npm run typecheck        # Type-check without emitting
npm test                 # Run all tests (Node.js built-in test runner via tsx)
npm run test:coverage    # Tests with c8 coverage
```

Run a single test file:
```bash
npx tsx --test src/routes/agents.test.ts
```

### Dashboard (in `dashboard/`)

A React + Vite SPA for monitoring agents, builds, tasks, and messages in real time. Uses TanStack Router, TanStack Query, and Mantine UI.

```bash
npm run dev              # Start Vite dev server
npm run build            # Type-check + production build
npm run preview          # Preview production build locally
```

The dashboard talks to the coordination server (default `http://localhost:9100`).

### Shell Scripts (from repo root, requires Git Bash on Windows)

```bash
./setup.sh               # First-time setup (prereqs, config files, deps)
./launch.sh              # Launch container agent (resumes existing branch by default)
./launch.sh --fresh      # Reset agent branch to docker/{project-id}/current-root before launch
./launch.sh --dry-run    # Preview resolved config and branch names without launching
./stop.sh                # Stop all running agent containers
./stop.sh --agent agent-1  # Stop a specific agent
./stop.sh --drain        # Graceful shutdown (pause pumps, wait for in-flight tasks, stop)
./status.sh --follow     # Monitor agent progress (polls every 5s)
./scripts/ingest-tasks.sh --tasks-dir ./tasks  # Ingest task markdown files into task queue
```

Validate shell scripts: `bash -n launch.sh && bash -n setup.sh && bash -n status.sh && bash -n stop.sh`

## Architecture

### Four-Layer System

1. **Shell scripts** (`launch.sh`, `setup.sh`, `status.sh`, `stop.sh`) — orchestrate Docker and config. Read structural config from `scaffold.config.json` and secrets from `.env`.

2. **Coordination server** (`server/`) — Fastify + TypeScript, SQLite via better-sqlite3 (WAL mode). Runs on the host (default port 9100). Provides:
   - `GET /health` — server health check (returns status, db path, config summary)
   - `POST /build`, `POST /test` — sync worktree from bare repo, run host-side build/test scripts, return structured `{success, exit_code, output, stderr}`
   - `GET /builds` — query build history with filtering
   - `POST /agents/register`, `GET /agents`, `GET /agents/{name}`, `POST /agents/{name}/status`, `DELETE /agents/{name}`, `DELETE /agents` — agent lifecycle
   - `POST /agents/{name}/sync` — merge `docker/{project-id}/current-root` into `docker/{project-id}/{name}`; propagates plans to running containers
   - `GET /messages`, `POST /messages`, `GET /messages/{channel}`, `POST /messages/{channel}/count`, `POST /messages/{id}/claim`, `POST /messages/{id}/resolve` — SQLite-backed message board for agent progress
   - UBT lock (`GET /ubt/status`, `POST /ubt/acquire`, `POST /ubt/release`) — singleton mutex with priority queue and stale-lock sweeping (60s interval)
   - `/tasks/*` — task queue with claim/complete/fail/release lifecycle for worker mode
   - `POST /sync/plans` — merge committed state from the exterior repo into the bare repo's `docker/{project-id}/current-root` branch; optionally propagates to agent branches via `targetAgents` body param
   - `GET /search` — full-text search across tasks, messages, agents
   - `GET /files` — file ownership registry (tracks which agent owns which files)
   - `/coalesce/*` — system-wide coordination: pause pump agents, wait for in-flight tasks, release file ownership

3. **Docker container** (`container/`) — runs a single Claude Code instance in non-interactive mode (`claude -p`). The entrypoint (`entrypoint.sh`) clones from a bare repo, excludes `.claude/` from git tracking via `.git/info/exclude`, registers with the coordination server, and delegates to the specified agent type. The repo's `CLAUDE.md` is environment-agnostic — no patching needed. User-level Claude settings (hooks, agents, credentials) are mounted from outside the repo.

4. **Dashboard** (`dashboard/`) — React + Vite SPA for real-time monitoring of agents, builds, tasks, and messages. Polls the coordination server. See Commands section above.

### Git Data Flow

```
Host Project (exterior repo) → POST /sync/plans → [bare repo] ← Container (clone/push)
                                                       │
                                docker/{project-id}/current-root   ← seed branch; synced from exterior repo
                                docker/{project-id}/agent-1        ← agent-1's working branch
                                docker/{project-id}/agent-2        ← agent-2's working branch
                                                       │
                                Server fetches agent branch → Staging Worktree → Build/Test
```

Containers clone from `docker/{project-id}/{agent-name}` and push back to it. The bare repo is
persistent — created once by `setup.sh`, never recreated on launch. The exterior repo
(where interactive sessions and planning happen) is synced into the bare repo's
`docker/{project-id}/current-root` branch via `POST /sync/plans`.

### Build Hook Interception

Container agents don't run builds directly. Two PreToolUse hooks in `container/hooks/` enforce this:

- **`intercept_build_test.sh`** — intercepts build/test commands, commits+pushes to the bare repo, then calls the coordination server's `/build` or `/test` endpoint. The server syncs to a staging worktree and runs the real UE build scripts.
- **`block-push-passthrough.sh`** — blocks manual `git push` commands. Pushes are handled automatically by the build/test intercept hook, so direct pushes are an error.

### Task-Queue Execution

Containers get work from the task queue. The workflow is:

1. Ingest tasks via `POST /tasks` or `scripts/ingest-tasks.sh`
2. Launch a container with `./launch.sh` (no plan file needed)
3. The container polls `POST /tasks/claim-next` to claim and execute tasks

By default the container resumes its existing branch; `--fresh` resets it to `docker/{project-id}/current-root` HEAD first. Use `--worker` for single-task mode or `--pump` for continuous multi-task mode.

### Branch Model

```
docker/{project-id}/current-root    ← seed branch (fresh containers start here)
docker/{project-id}/agent-1         ← agent-1's working branch
docker/{project-id}/agent-2         ← agent-2's working branch
```

- The exterior repo is the source of truth for plans and design work. `POST /sync/plans` merges its committed state into `docker/{project-id}/current-root` in the bare repo.
- Containers fork from `docker/{project-id}/current-root` on first launch and push to `docker/{project-id}/{agent-name}`.
- `--fresh` resets the agent branch to `docker/{project-id}/current-root` HEAD.
- Default (no `--fresh`) resumes from the agent's existing branch.
- Plans must be committed in the exterior repo, then synced to the bare repo via `POST /sync/plans` (or the dashboard's "Sync Bare Repo" button) before tasks can reference them. The server validates plan `sourcePath` references against `docker/{project-id}/current-root` in the bare repo.
- Plans on `docker/{project-id}/current-root` can be merged into agent branches via `POST /agents/{name}/sync`, `targetAgents` on `POST /tasks`, or `targetAgents` on `POST /sync/plans`.

### Agent Definitions

Agent type definitions live in `agents/` as markdown files. Each defines the agent's role, available tools, and behavioral instructions. The `AGENT_TYPE` env var in `.env` selects which definition to use at launch. Current agent types:

- `container-orchestrator` — default for container execution; executes a plan E2E by delegating to sub-agents
- `container-implementer` — writes code according to a plan or fix instructions
- `container-reviewer` — reviews implementation against spec and project style
- `container-tester` — writes and runs tests for an implementation

### Server Code Conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions even for `.ts` files
- Fastify plugins pattern — each route file exports a `FastifyPluginAsync` as default
- Tests use Node.js built-in `node:test` + `node:assert` (no Jest/Vitest)
- Test helper (`src/test-helper.ts`) creates isolated Fastify instances with temp SQLite DBs
- DB schema is embedded in `src/db.ts` as a single source of truth (no migration files)
- Agent identification via `X-Agent-Name` header on requests

### Configuration Split

- `scaffold.config.json` — structural config (paths, ports, build scripts, path remaps). Not committed (user-specific). Copy from `scaffold.config.example.json`.
- `.env` — secrets and per-launch params (auth credentials, agent name, branch). Not committed. Copy from `.env.example`.
- `container/docker-compose.yml` — Docker Compose config with local volume mounts. Not committed (user-specific). Copy from `container/docker-compose.example.yml`.
- `container/container-settings.json` — Claude Code settings injected into containers (hooks config, permissions)
- `container/instructions/*.md` — standing instructions prepended to every task prompt (sorted by filename):
  - `00-build-loop.md` — build routing and UBT queue discipline
  - `01-debrief.md` — debrief/reporting instructions
  - `02-messages.md` — message board and monitoring guidance
  - `03-task-worker.md` — task worker mode protocol

### Issues

The `issues/` directory contains markdown files raised by any team member (interactive sessions, dev teams, the user). Each file has frontmatter (`title`, `priority`, `reported-by`, `date`) and a short description of the problem or suggestion. Issues are work items to discuss with the user when prompted — if an idea gains momentum, it gets developed further.
