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
./scripts/launch-team.sh             # Server-side team launch (called by launch.sh --team)
```

Validate shell scripts: `bash -n launch.sh && bash -n setup.sh && bash -n status.sh && bash -n stop.sh && bash -n scripts/launch-team.sh`

## Architecture

### Four-Layer System

1. **Shell scripts** (`launch.sh`, `setup.sh`, `status.sh`, `stop.sh`) — focused dispatch scripts that delegate logic to shared libraries in `scripts/lib/`. Source reusable functions from `scripts/lib/` (validators, config resolution, compose detection, branch setup, container launching, agent compilation, hook resolution, curl helpers, colors, arg parsing, stop helpers, resolved-config printing). Read structural config from `scaffold.config.json` and secrets from `.env`.

2. **Coordination server** (`server/`) — Fastify + TypeScript, PGlite (in-process Postgres) accessed via Drizzle ORM. Runs on the host (default port 9100). The server relies on network isolation and is not hardened for internet exposure — it is designed to be accessed only by local Docker containers and the operator's dashboard. Requests are scoped by the `X-Project-Id` header (default `default`); every persisted row — agents, tasks, messages, builds, ubt_lock, files, rooms, teams — carries a `project_id` column so a single server serves multiple UE projects in isolation. The server owns config resolution, branch operations, hook cascade generation, container-settings rendering, exit classification, team launch orchestration, task ingestion, agent definition compilation, and C++ diff linting. Provides:
   - `GET /health` — server health check (returns status, db path, config summary)
   - `GET /status` — aggregate status overview (agents, tasks, builds, UBT lock)
   - `GET /projects`, `POST /projects` — list and register projects (portable config stored in the `projects` table)
   - `GET /config/{projectId}` — resolved project configuration for shell scripts and containers
   - `POST /build`, `POST /test` — sync worktree from bare repo, run host-side build/test scripts, return structured `{success, exit_code, output, stderr}`
   - `GET /builds` — query build history with filtering
   - `POST /agents/register`, `GET /agents`, `GET /agents/{name}`, `POST /agents/{name}/status`, `DELETE /agents/{name}`, `DELETE /agents` — agent lifecycle
   - `POST /agents/{name}/sync` — merge `docker/{project-id}/current-root` into `docker/{project-id}/{name}`; propagates plans to running containers
   - `POST /agents/{name}/branch` — branch setup operations (create, reset, verify agent branches)
   - `POST /agents/{name}/exit-classify` — classify agent exit codes and decide retry/stop/report
   - `POST /hooks/resolve` — stateless hook cascade resolution (intercept, guard, push, lint) from request body
   - `GET /agents/{name}/settings.json`, `GET /agents/{name}/mcp.json` — render container settings and MCP config for an agent
   - `POST /tasks/ingest` — ingest task markdown files into the task queue
   - `POST /teams/{id}/launch` — orchestrate team container launches
   - `GET /messages`, `POST /messages`, `GET /messages/{channel}`, `POST /messages/{channel}/count`, `POST /messages/{id}/claim`, `POST /messages/{id}/resolve` — message board for agent progress
   - `/rooms/*` — threaded message rooms (alternative to the flat message board)
   - `/teams/*` — design team registration and lifecycle
   - UBT lock (`GET /ubt/status`, `POST /ubt/acquire`, `POST /ubt/release`) — singleton mutex with priority queue and stale-lock sweeping (60s interval)
   - `/tasks/*` — task queue split across `tasks.ts`, `tasks-claim.ts`, `tasks-lifecycle.ts`, `tasks-files.ts`, `tasks-replan.ts` (claim/complete/fail/release/replan lifecycle for worker mode)
   - `POST /sync/plans` — merge committed state from the exterior repo into the bare repo's `docker/{project-id}/current-root` branch; optionally propagates to agent branches via `targetAgents` body param
   - `GET /search` — full-text search across tasks, messages, agents
   - `GET /files` — file ownership registry (tracks which agent owns which files)
   - `/coalesce/*` — system-wide coordination: pause pump agents, wait for in-flight tasks, release file ownership

3. **Docker container** (`container/`) — runs a single Claude Code instance in non-interactive mode (`claude -p`). The entrypoint (`entrypoint.sh`) is a thin dispatcher that sources shared libraries from `container/lib/` (env.sh for environment setup, workspace-setup.sh for git clone/checkout, registration.sh for server registration, finalize.sh for git exclude and settings, run-claude.sh for launching Claude, pump-loop.sh for multi-task mode, post-setup.sh for plugin symlinking). The repo's `CLAUDE.md` is environment-agnostic — no patching needed. User-level Claude settings (hooks, agents, credentials) are mounted from outside the repo.

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

`{project-id}` is the scoping key shared by config, DB rows, and git branches. Each project gets its own bare repo directory and its own set of `docker/{project-id}/*` branches.

### Build Hook Interception

Container agents don't run builds directly. Two PreToolUse hooks in `container/hooks/` enforce this:

- **`intercept_build_test.sh`** — intercepts build/test commands, commits+pushes to the bare repo, then calls the coordination server's `/build` or `/test` endpoint. The server syncs to a staging worktree and runs the real UE build scripts.
- **`block-push-passthrough.sh`** — blocks manual `git push` commands. Pushes are handled automatically by the build/test intercept hook, so direct pushes are an error.
- Additional hooks in `container/hooks/` cover branch guarding (`guard-branch.sh`), agent header injection (`inject-agent-header.sh`), post-commit auto-push (`push-after-commit.sh`), and C++ diff linting (`lint-cpp-diff.mjs`). No Python is required — the project uses only bash and Node.js/TypeScript.

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
- Scripts target a specific project via `--project <id>`. If `scaffold.config.json` has exactly one project (including a legacy single-project config synthesized as `default`), the flag can be omitted.

### Agent Definitions

Agent type definitions live in `agents/` as markdown files. Each defines the agent's role, available tools, and behavioral instructions. The `AGENT_TYPE` env var in `.env` selects which definition to use at launch. Current agent types:

- `container-orchestrator` — default for container execution; executes a plan E2E by delegating to sub-agents
- `container-implementer` — writes code according to a plan or fix instructions
- `container-reviewer` — generic reviewer for spec and project style
- `container-decomposition-reviewer` — review focused on decomposition criteria including lifetime/safety
- `container-safety-reviewer` — review focused on memory/thread safety and invariants
- `container-style-reviewer` — review focused on style and coding conventions
- `container-tester` — writes and runs tests for an implementation
- `changeling` — adaptive agent template (see `agents/changeling.md`)

### Server Code Conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions even for `.ts` files
- Fastify plugins pattern — each route file exports a `FastifyPluginAsync` as default
- Tests use Node.js built-in `node:test` + `node:assert/strict`
- Test setup uses `server/src/drizzle-test-helper.ts` (creates isolated PGlite + Drizzle databases per test); `server/src/test-helper.ts` re-exports it and provides config helpers
- DB schema is defined in `server/src/schema/tables.ts`; SQL migrations live in `server/drizzle/` and are applied via `npm run db:migrate` (which runs `src/migrate.ts`)
- Agent identification via `X-Agent-Name` header on requests
- Project scoping via `X-Project-Id` header; see `server/src/plugins/project-id.ts`. Branch naming helpers in `server/src/branch-naming.ts` (`seedBranchFor`, `agentBranchFor`)

### Configuration Split

- `scaffold.config.json` — structural config (paths, ports, build scripts, path remaps). Not committed (user-specific). Copy from `scaffold.config.example.json`. Supports either the legacy single-project shape (top-level `project`, `engine`, `build`, `server` fields) or a multi-project shape with a `projects: { [id]: ProjectConfig }` map. Legacy configs are synthesized internally as `{ default: {...} }`.
- `.env` — secrets and per-launch params (auth credentials, agent name, branch). Not committed. Copy from `.env.example`.
- `container/docker-compose.yml` — Docker Compose config with local volume mounts. Not committed (user-specific). Copy from `container/docker-compose.example.yml`.
- `container/container-settings.json` — Claude Code settings injected into containers (hooks config, permissions)
- `skills/` — modular skills loaded by dynamic agent definitions. Each skill is a directory with a `SKILL.md`. Current skills include `task-worker-protocol`, `orchestrator-phase-protocol`, and `debrief-protocol`.

### Issues

The `issues/` directory contains markdown files raised by any team member (interactive sessions, dev teams, the user). Each file has frontmatter (`title`, `priority`, `reported-by`, `date`) and a short description of the problem or suggestion. Issues are work items to discuss with the user when prompted — if an idea gains momentum, it gets developed further.
