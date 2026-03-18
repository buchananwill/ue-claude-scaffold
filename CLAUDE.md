# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A scaffold for running autonomous Claude Code agents in Docker containers against Unreal Engine projects. Containers can't install UE, so build/test requests are routed back to the host through a Fastify coordination server that serializes UBT (Unreal Build Tool) access.

## Commands

### Coordination Server (in `server/`)

```bash
npm run dev              # Start dev server with hot reload (tsx watch)
npm run build            # TypeScript compile to dist/
npm run typecheck        # Type-check without emitting
npm test                 # Run all tests (Node.js built-in test runner via tsx)
npm run test:coverage    # Tests with c8 coverage
```

Run a single test file:
```bash
npx tsx --test src/routes/agents.test.ts
```

### Shell Scripts (from repo root, requires Git Bash on Windows)

```bash
./setup.sh               # First-time setup (prereqs, config files, deps)
./launch.sh --plan path/to/plan.md   # Launch container agent
./launch.sh --dry-run    # Preview resolved config without launching
./status.sh --follow     # Monitor agent progress (polls every 5s)
./scripts/ingest-tasks.sh --tasks-dir ./tasks  # Ingest task markdown files into task queue
```

Validate shell scripts: `bash -n launch.sh && bash -n setup.sh && bash -n status.sh`

## Architecture

### Three-Layer System

1. **Shell scripts** (`launch.sh`, `setup.sh`, `status.sh`) — orchestrate Docker and config. Read structural config from `scaffold.config.json` and secrets from `.env`.

2. **Coordination server** (`server/`) — Fastify + TypeScript, SQLite via better-sqlite3 (WAL mode). Runs on the host (default port 9100). Provides:
   - `POST /build`, `POST /test` — sync worktree from bare repo, run host-side build/test scripts, return structured `{success, exit_code, output, stderr}`
   - `POST /agents/register`, `GET /agents`, agent status lifecycle
   - `GET /messages`, `POST /messages` — SQLite-backed message board for agent progress
   - UBT lock (`/ubt/lock`, `/ubt/release`) — singleton mutex with stale-lock sweeping (60s interval)
   - `/tasks/*` — task queue with claim/complete/fail/release lifecycle for worker mode

3. **Docker container** (`container/`) — runs a single Claude Code instance in non-interactive mode (`claude -p`). The entrypoint clones from a bare repo, patches CLAUDE.md paths for the container environment, registers with the coordination server, and delegates to the specified agent type.

### Git Data Flow

```
Host Project Worktree → [bare repo] → Container Clone
                                           ↓
                                      Agent works
                                           ↓
                                  Container pushes → [bare repo]
                                                          ↓
                          Server fetches → Staging Worktree → Build/Test
```

### Build Hook Interception

Container agents don't run builds directly. A PreToolUse hook (`container/hooks/intercept_build_test.sh`) intercepts build/test commands, commits+pushes to the bare repo, then calls the coordination server's `/build` or `/test` endpoint. The server syncs to a staging worktree and runs the real UE build scripts.

### Two Execution Modes

- **Plan mode** (default): `launch.sh --plan plan.md` copies the plan to `tasks/prompt.md`, container reads it and executes E2E
- **Worker mode**: `launch.sh --worker` — container polls `GET /tasks?status=pending`, claims tasks, executes them, reports results

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
- `container/container-settings.json` — Claude Code settings injected into containers
- `container/instructions/*.md` — standing instructions prepended to every task prompt (sorted by filename)
