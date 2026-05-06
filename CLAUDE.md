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
npm run lint             # ESLint
npm test                 # Vitest unit tests
```

The dashboard talks to the coordination server (default `http://localhost:9100`). Pages: Overview, Agent Detail, Build Log, Chat, Messages, Search, Task Detail, Teams.

### Shell Scripts (from repo root, requires Git Bash on Windows)

```bash
./setup.sh               # First-time setup (prereqs, config files, deps)
./launch.sh              # Launch container agent (resumes existing branch by default)
./launch.sh --fresh      # Reset agent branch to docker/{project-id}/current-root before launch
./launch.sh --worker     # Single-task worker (claim one task, exit)
./launch.sh --pump       # Continuous pump (claim tasks until drained)
./launch.sh --parallel N # Launch N pump containers in parallel
./launch.sh --team T --brief PATH   # Launch a design team with a brief
./launch.sh --prompt "…"            # One-shot direct prompt (bypass task queue)
./launch.sh --effort high           # Override CLAUDE_EFFORT (low|medium|high|xhigh|max)
./launch.sh --verbosity verbose     # Message-board verbosity (quiet|normal|verbose)
./launch.sh --hooks / --no-hooks    # Force hook bundle on/off
./launch.sh --no-agent              # Skip agent registration (debugging)
./launch.sh --dry-run    # Preview resolved config and branch names without launching
./stop.sh                # Stop all running agent containers
./stop.sh --agent agent-1  # Stop a specific agent
./stop.sh --team T       # Stop a design team and dissolve it
./stop.sh --drain        # Graceful shutdown (pause pumps, wait for in-flight tasks, stop)
./status.sh --follow     # Monitor agent progress (polls every 5s)
./scripts/ingest-tasks.sh --tasks-dir ./tasks  # Ingest task markdown files into task queue
./scripts/launch-team.sh             # Server-side team launch (called by launch.sh --team)
```

Validate shell scripts: `bash -n launch.sh && bash -n setup.sh && bash -n status.sh && bash -n stop.sh && bash -n scripts/launch-team.sh`

## Architecture

### Four-Layer System

1. **Shell scripts** (`launch.sh`, `setup.sh`, `status.sh`, `stop.sh`) — focused dispatch scripts that delegate logic to shared libraries in `scripts/lib/`. Source reusable functions from `scripts/lib/` (validators, config resolution, compose detection, branch setup, container launching, agent compilation, hook resolution, curl helpers, colors, arg parsing, stop helpers, resolved-config printing). Read structural config from `scaffold.config.json` and secrets from `.env`.

2. **Coordination server** (`server/`) — Fastify + TypeScript, Postgres on Supabase (reached via `SCAFFOLD_DATABASE_URL`) accessed via Drizzle ORM. PGlite (in-process Postgres) is the fallback backend when `SCAFFOLD_DATABASE_URL` is unset — used for tests and offline development. Runs on the host (default port 9100). The server relies on network isolation and is not hardened for internet exposure — it is designed to be accessed only by local Docker containers and the operator's dashboard. Requests are scoped by the `X-Project-Id` header (default `default`); every persisted row — agents, tasks, messages, builds, ubt_lock, files, rooms, teams — carries a `project_id` column so a single server serves multiple UE projects in isolation. The server owns config resolution, branch operations, hook cascade generation, container-settings rendering, exit classification, team launch orchestration, task ingestion, agent definition compilation, and C++ diff linting. Provides:
   - `GET /health` — server health check (returns status, db path, config summary)
   - `GET /status` — aggregate status overview (agents, tasks, recent messages from the general channel)
   - `GET /projects`, `POST /projects`, `GET /projects/{id}`, `PATCH /projects/{id}`, `DELETE /projects/{id}` — project CRUD (portable config stored in the `projects` table)
   - `POST /projects/{id}/seed/bootstrap` — bootstrap a bare repo and create the seed branch for a project
   - `GET /config` — list all project IDs known to the config
   - `GET /config/{projectId}` — resolved project configuration for shell scripts and containers
   - `POST /build`, `POST /test` — sync worktree from bare repo, run host-side build/test scripts, return structured `{success, exit_code, output, stderr}`
   - `GET /builds` — query build history with filtering
   - `POST /agents/register`, `GET /agents`, `GET /agents/{name}`, `POST /agents/{name}/status`, `DELETE /agents/{name}`, `DELETE /agents` — agent lifecycle. `DELETE /agents/{name}` performs a single-phase soft-delete (sets `status = 'deleted'`); optional `sessionToken` query parameter returns 409 on mismatch
   - `POST /agents/{name}/sync` — merge `docker/{project-id}/current-root` into `docker/{project-id}/{name}`; propagates plans to running containers
   - `POST /agents/{name}/branch` — branch setup operations (create, reset, verify agent branches)
   - `POST /agents/{name}/exit-classify` — classify agent exit codes and decide retry/stop/report
   - `POST /hooks/resolve` — stateless hook cascade resolution (intercept, guard, push, lint) from request body
   - `GET /agents/{name}/settings.json`, `GET /agents/{name}/mcp.json` — render container settings and MCP config for an agent
   - `GET /agents/definitions/:type` — compile and return an agent definition (markdown + meta sidecar) plus its referenced sub-agents in one round-trip; consumed by containers that need to fetch a non-default agent on the fly
   - `POST /tasks/ingest` — ingest task markdown files into the task queue
   - `POST /teams/{id}/launch` — orchestrate team container launches
   - `POST /messages`, `GET /messages/{channel}`, `GET /messages/{channel}/count`, `POST /messages/{id}/claim`, `POST /messages/{id}/resolve`, `DELETE /messages/{param}` — message board for agent progress
   - `/rooms/*` — threaded message rooms (alternative to the flat message board); includes `GET /transcript` for plain-text human-readable transcripts
   - `/teams/*` — design team registration and lifecycle
   - UBT lock (`GET /ubt/status`, `POST /ubt/acquire`, `POST /ubt/release`) — singleton mutex with priority queue and stale-lock sweeping (60s interval)
   - `/tasks/*` — task queue split across `tasks.ts`, `tasks-claim.ts`, `tasks-lifecycle.ts`, `tasks-replan.ts`, `tasks-ingest.ts` (claim/complete/fail/release/replan lifecycle for worker mode; helpers and shared types live in `tasks-files.ts` and `tasks-types.ts`). Tasks carry an optional `agentTypeOverride` column so a single pump container can run different agent definitions per task — validated by a CHECK constraint on `tasks.agent_type_override`, by `validateAgentTypeOverride` on every write route, by an `agentTypeOverride` filter on `GET /tasks` (with the `__default__` sentinel for "no override"), and by an allowlist regex in `container/lib/pump-loop.sh` before the container exports the agent type for the next iteration
   - `POST /sync/plans` — merge committed state from the exterior repo into the bare repo's `docker/{project-id}/current-root` branch; optionally propagates to agent branches via `targetAgents` body param
   - `GET /search` — full-text search across tasks, messages, agents
   - `GET /files` — file ownership registry (tracks which agent owns which files)
   - `/coalesce/*` — system-wide coordination: pause pump agents, wait for in-flight tasks, release file ownership

3. **Docker container** (`container/`) — runs a single Claude Code instance in non-interactive mode (`claude -p`). The entrypoint (`entrypoint.sh`) is a thin dispatcher that sources shared libraries from `container/lib/` (`env.sh` for environment setup, `workspace-setup.sh` for git clone/checkout, `registration.sh` for server registration and chat-room join, `finalize.sh` for git exclude and settings, `run-claude.sh` for launching Claude, `pump-loop.sh` for multi-task mode, `post-setup.sh` for plugin symlinking, `agent-fetch.sh` for on-the-fly agent definition fetching). Compose files are layered: `docker-compose.template.yml` is the base, `docker-compose.engine.yml` adds the UE engine mount when configured, and `docker-compose.example.yml` is the user-copyable starting point. A bundled MCP server (`container/mcp-servers/chat-channel.mjs`) wires the agent's chat-room participation through Claude's MCP layer. The repo's `CLAUDE.md` is environment-agnostic — no patching needed. User-level Claude settings (hooks, agents, credentials) are mounted from outside the repo.

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

Container agents don't run builds directly. Hooks in `container/hooks/` enforce the host-side build path and project conventions:

- **`intercept_build_test.sh`** (PreToolUse) — intercepts build/test commands, commits+pushes to the bare repo, then calls the coordination server's `/build` or `/test` endpoint. The server syncs to a staging worktree and runs the real UE build scripts.
- **`block-push-passthrough.sh`** (PreToolUse) — blocks manual `git push` commands. Pushes are handled automatically by the build/test intercept hook, so direct pushes are an error.
- **`guard-branch.sh`** — refuses commits made on the wrong branch.
- **`inject-agent-header.sh`** — injects `X-Agent-Name` / `X-Project-Id` headers on outbound `curl` calls to the coordination server.
- **`push-after-commit.sh`** — auto-pushes to the bare repo after every commit.
- **`lint-cpp-diff.mjs`** — Node-based C++ diff linter (UE-specific style/safety rules); ships with `lint-cpp-diff.test.mjs`.
- **`lint-format.sh`** — generic format/lint dispatcher used by JS/TS-only projects.

The hook bundle that runs in any given container is decided server-side via `POST /hooks/resolve` and projected into the container's `settings.json` via `GET /agents/{name}/settings.json`. No Python is required — the project uses only bash and Node.js/TypeScript.

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

The scaffold has two parallel agent definition trees:

- **`agents/`** — static, hand-authored markdown definitions. The minimal fallback set used when no skills composition is needed. Includes `container-orchestrator`, `container-implementer`, `container-reviewer`, `container-decomposition-reviewer`, `container-safety-reviewer`, `container-style-reviewer`, `container-tester`, and the `changeling` adaptive template. Shared fragments live in `agents/core/`.
- **`dynamic-agents/`** — skills-composed definitions that are the active set used in practice. Each `.md` file declares a `skills:` list in front matter; the compiler in `server/src/agent-compiler.ts` (CLI: `server/src/bin/compile-agent.ts`, exposed as the `compile-agent` binary) inlines those skills and writes a flattened pair (`<name>.md` + `<name>.meta.json`) into `.compiled-agents/`. Includes per-stack orchestrators (`container-orchestrator-ue`, `scaffold-orchestrator`, `scaffold-server-orchestrator`, `scaffold-dashboard-orchestrator`, `content-catalogue-dashboard-orchestrator`), implementers, role-specialised reviewers (decomposition / safety / correctness / react-quality / browser-safety / typescript-type), style-sweep agents, and the design-team roster (`design-leader`, `design-architect`, `design-domain`, `design-data`, `design-ui`, `design-ui-mantine`, `design-elegance`, `design-performance`, `design-safety`, `design-critic`, `cleanup-leader`).

`AGENT_TYPE` in `.env`, `--agent-type` on `launch.sh`, or `projects.<id>.agentType` in `scaffold.config.json` selects which definition to use at launch. The launcher first tries to compile from `dynamic-agents/` and falls back to `agents/` if no matching dynamic definition exists. The coordination server probes every `dynamic-agents/*.md` once at startup and logs any that fail to compile so broken definitions surface immediately rather than at first runtime fetch.

Reasoning effort for the top-level container session is controlled by `CLAUDE_EFFORT` (`.env`) / `--effort` (`launch.sh`) / `projects.<id>.effort` (`scaffold.config.json`). Valid values: `low`, `medium`, `high` (default), `xhigh`, `max`. This currently only affects the top-level session — sub-agents spawned via the Agent tool inherit the harness default.

### Server Code Conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions even for `.ts` files
- Fastify plugins pattern — each route file exports a `FastifyPluginAsync` as default
- Tests use Node.js built-in `node:test` + `node:assert/strict`
- Test setup uses `server/src/drizzle-test-helper.ts` (creates isolated PGlite + Drizzle databases per test); `server/src/test-helper.ts` re-exports it and provides config helpers
- DB schema is defined in `server/src/schema/tables.ts`; SQL migrations live in `server/drizzle/` and are applied via `npm run db:migrate` (which runs `src/migrate.ts`)
- Agent identification via `X-Agent-Name` header on requests. Agent identity is `agents.id` (UUID v7); `(project_id, name)` is a unique human-readable slot, not an identity. Every agent query must take an explicit `projectId`. Agents are soft-deleted via `status = 'deleted'`; hard deletion is a vacuum-class operation not performed in normal flow
- Project scoping via `X-Project-Id` header; see `server/src/plugins/project-id.ts`. Branch naming helpers in `server/src/branch-naming.ts` (`seedBranchFor`, `agentBranchFor`)
- FK constraints enforce cross-table integrity; `project_id` is a foreign key to `projects.id` on every project-scoped data table. UBT tables (`ubt_lock`, `ubt_queue`) are host-level — keyed by `host_id`, no `project_id` column or FK
- `room_members` is agent-only; the operator authors messages without being a member. `chat_messages` carries an `author_type` discriminator (`agent` / `operator` / `system`)

### Configuration Split

- `scaffold.config.json` — structural config (paths, ports, build scripts, path remaps). Not committed (user-specific). Copy from `scaffold.config.example.json`. Supports either the legacy single-project shape (top-level `project`, `engine`, `build`, `server` fields) or a multi-project shape with a `projects: { [id]: ProjectConfig }` map. Legacy configs are synthesized internally as `{ default: {...} }`.
- `.env` — secrets and per-launch params (auth credentials, agent name, branch). Not committed. Copy from `.env.example`.
- `SCAFFOLD_DATABASE_URL` — Postgres connection URL for the coordination server. Set in the shell that runs the server (the scaffold deliberately ignores any inherited `DATABASE_URL` to avoid hijack from a co-installed unrelated Supabase project). Unset it to fall back to PGlite. Rollback recipe: [Notes/operational-runbook.md](./Notes/operational-runbook.md).
- `container/docker-compose.yml` — Docker Compose config with local volume mounts. Not committed (user-specific). Copy from `container/docker-compose.example.yml`. The launcher applies `container/docker-compose.template.yml` as the base and conditionally layers `container/docker-compose.engine.yml` when an engine path is configured.
- `container/container-settings.json` — Claude Code settings injected into containers (hooks config, permissions).
- `container/mcp-servers/` — bundled MCP servers loaded inside the container; currently just `chat-channel.mjs` for chat-room participation.
- `skills/` — modular skills loaded by `dynamic-agents/` definitions. Each skill is a directory with a `SKILL.md`. The repo currently ships ~65 skills including `task-worker-protocol`, `orchestrator-phase-protocol`, `debrief-protocol`, `ue-cpp-style`, `ue-decomposition`, `ue-safety`, `general-correctness`, `general-decomposition`, `quality-philosophy`, `commit-discipline`, `react-component-discipline`, `typescript-type-discipline`, the `mandate-*` axes, and several `*-system-wiring` / `*-patterns` packs.
- `dynamic-agents/` and `.compiled-agents/` — see Agent Definitions above. `.compiled-agents/` is generated; do not hand-edit.
- `Notes/` — operator-facing runbooks and design notes. Start at `Notes/operational-runbook.md` for DB rollback recipes.

### Issues

The `issues/` directory contains markdown files raised by any team member (interactive sessions, dev teams, the user). Each file has frontmatter (`title`, `priority`, `reported-by`, `date`) and a short description of the problem or suggestion. Issues are work items to discuss with the user when prompted — if an idea gains momentum, it gets developed further.
