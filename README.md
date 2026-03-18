# @ue-claude/scaffold

Run Claude Code autonomously against Unreal Engine projects. Human authors the plan, container executes it end-to-end, message board provides live inspectability.

## What this is

A turnkey scaffold for handing off implementation work to autonomous Claude Code agents running in Docker containers. Designed for UE developers who already use Claude Code interactively and want to delegate longer tasks.

Unreal Engine builds require the real engine installation on the host — you cannot install UE inside a container. This scaffold solves that by isolating the autonomous agent's work inside a container while routing build and test requests back to the host through a coordination server. The server serializes access to Unreal Build Tool (UBT), which does not support concurrent invocations, making future multi-agent support safe by design.

**The workflow:**
1. Design your plan interactively with Claude Code (human in the loop)
2. Commit the plan as a markdown document
3. Launch a container agent — it executes the plan E2E
4. Each phase builds, passes code review, and commits with a debrief audit trail
5. Monitor progress via the coordination server's message board

## Prerequisites

- [Git](https://git-scm.com/) 2.25+
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose v2 (or the standalone `docker-compose` v1.29+)
- [Node.js](https://nodejs.org/) 22+
- [jq](https://jqlang.github.io/jq/download/) (JSON processor — used by all scaffold scripts)
- A Claude authentication method:
  - **OAuth** (Claude Pro/Max subscription) — mount your `~/.claude/.credentials.json`
  - **API key** — set `ANTHROPIC_API_KEY` environment variable
- An Unreal Engine installation (for the host-side build system)

**Shell note:** On Windows, use Git Bash or WSL. The launch and setup scripts require a Bash-compatible shell.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/your-org/ue-claude-scaffold.git
cd ue-claude-scaffold

# 2. Run first-time setup (checks prerequisites, creates config files, installs deps)
./setup.sh

# 3. Edit .env with your authentication credentials

# 4. Edit scaffold.config.json with your project paths
#    Required: project.path, engine.path, server.bareRepoPath, tasks.path

# 5. Start the coordination server
cd server && npm run dev

# 6. In another terminal — launch an agent with a plan
./launch.sh --plan path/to/your-plan.md

# 7. Monitor progress
./status.sh --follow
```

## Project Structure

```
ue-claude-scaffold/
├── agents/                    # Claude Code agent definitions
│   └── container-orchestrator.md
├── container/                 # Docker container infrastructure
│   ├── Dockerfile
│   ├── docker-compose.yml     # Template compose file
│   ├── entrypoint.sh
│   ├── container-settings.json
│   ├── patch_workspace.py     # CLAUDE.md path remapping
│   ├── hooks/                 # Claude Code PreToolUse hooks
│   │   ├── intercept_build_test.sh
│   │   └── block-push-passthrough.sh
│   └── instructions/          # Standing instructions for container agents
│       ├── 00-build-loop.md
│       └── 01-debrief.md
├── server/                    # TypeScript coordination server
│   └── src/
├── tasks/                     # Task prompts directory
│   └── example-prompt.md
├── launch.sh                  # Parameterized agent launcher
├── setup.sh                   # First-time setup script
├── status.sh                  # Agent monitoring dashboard
├── .env.example
├── .gitattributes
├── scaffold.config.example.json
├── LICENSE                    # MIT
└── README.md
```

## How It Works

### Container Agent Architecture

Each container runs a single Claude Code instance in non-interactive (`-p`) mode with a delegated agent type (default: `container-orchestrator`). The orchestrator:

1. Reads the plan from the task prompt
2. Resolves sub-agents from the project's CLAUDE.md role mapping
3. Delegates each phase to an **implementer** -> verifies build -> delegates to **reviewer**
4. Iterates on failures (max 3 build retries, max 2 review cycles per phase)
5. Commits each phase with a debrief audit document

### Build/Test Routing

Containers don't have Unreal Engine installed. When Claude runs a build or test command, a PreToolUse hook intercepts it:

1. Commits and pushes current changes to a bare repo
2. Calls the coordination server's `/build` or `/test` endpoint
3. The server syncs changes to a host-side worktree and runs the real build
4. Returns structured output back to the container agent

### Coordination Server

A Fastify + TypeScript server running on the host. Provides:

- **Build/test proxy** -- routes container build requests to the host UE installation
- **Message board** -- SQLite-backed pub/sub for agent progress reporting
- **Agent registry** -- tracks active agents and their status
- **UBT lock** -- serializes build tool access (for future multi-agent support)

### Git Data Flow

```
Project Worktree --> [bare repo] --> Container Clone
                                          |
                                     Agent works
                                          |
                                 Container pushes --> [bare repo]
                                                           |
                                 Server fetches --> Staging Worktree --> Build/Test
```

The bare repo acts as a shared intermediary. The container clones from it on startup and pushes changes back when a build is requested. The server then fetches those changes into a staging worktree on the host where the real UE build tools run.

## Configuration

### `.env`

Secrets and per-launch parameters. Created from `.env.example` by `setup.sh`. Structural configuration (paths, ports, build scripts) lives in `scaffold.config.json`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_CREDENTIALS_PATH` | Yes* | — | Path to `.credentials.json` for OAuth auth |
| `ANTHROPIC_API_KEY` | Yes* | — | API key for token-based auth |
| `AGENT_NAME` | No | `agent-1` | Agent identifier |
| `WORK_BRANCH` | No | `main` | Git branch for the agent to work on |
| `AGENT_TYPE` | No | `container-orchestrator` | Agent definition to use |
| `MAX_TURNS` | No | `200` | Max Claude Code turns before stopping |

*One of `CLAUDE_CREDENTIALS_PATH` or `ANTHROPIC_API_KEY` is required.

### `scaffold.config.json`

Structural configuration. Created from `scaffold.config.example.json` by `setup.sh`.

| Field | Description |
|-------|-------------|
| `project.name` | Your UE project name |
| `project.path` | Absolute path to the project |
| `project.uprojectFile` | The `.uproject` filename |
| `engine.path` | Absolute path to the UE engine |
| `engine.version` | UE version string (e.g. `"5.7"`) |
| `tasks.path` | Absolute path to the tasks directory |
| `build.scriptPath` | Build script path relative to project root |
| `build.testScriptPath` | Test script path relative to project root |
| `build.defaultTestFilters` | Array of default test filter strings |
| `plugins.readOnlyMounts` | Plugin paths to mount read-only in containers |
| `container.agentType` | Default agent type for containers |
| `container.maxTurns` | Max turns for the agent |
| `container.defaultBranch` | Default branch for new agents |
| `server.port` | Coordination server port |
| `server.ubtLockTimeoutMs` | Timeout for UBT lock acquisition |
| `server.stagingWorktreePath` | Path to the host-side staging worktree |
| `server.bareRepoPath` | Path to the bare repo |
| `claudeMdPatches.pathRemaps` | Host-to-container path substitutions |
| `claudeMdPatches.agentSubstitutions` | Agent definition replacements for containers |

## Scripts

### `launch.sh`

Parameterized launcher for container agents.

```bash
# Launch with a plan (branch auto-derived from filename)
./launch.sh --plan plans/add-inventory-system.md
# -> branch: feature/add-inventory-system

# Explicit branch and agent name
./launch.sh --agent-name agent-2 --branch feature/ui --plan plans/ui-rework.md

# Preview what would happen without launching
./launch.sh --plan plans/my-plan.md --dry-run

# Full usage
./launch.sh --help
```

### `setup.sh`

First-time setup. Checks prerequisites, creates configuration files, installs server dependencies.

```bash
# Interactive setup (prompts for optional steps)
./setup.sh

# CI / scripted setup (skips prompts)
./setup.sh --non-interactive
```

### `status.sh`

Monitoring dashboard. Shows registered agents and message board activity.

```bash
# One-shot status check
./status.sh

# Continuous monitoring (refreshes every 5s)
./status.sh --follow

# Custom refresh interval (10s)
./status.sh --follow 10

# Only show messages after a specific ID
./status.sh --since 42
```

Requires `curl` and `jq`. Supports `NO_COLOR` environment variable to disable color output.

## Agent Definitions

The `agents/` directory contains agent definitions used by the container. When running in a container, agent definitions are automatically mounted from the scaffold's `agents/` directory. For interactive (non-container) Claude Code use, install them manually:

```bash
cp agents/*.md ~/.claude/agents/
```

### `container-orchestrator`

The default agent type for container execution. Executes a pre-authored plan autonomously -- no human approval gates. Each phase must build and pass code review before advancing.

### Customising for your project

Add an `### Orchestrator Role Mapping` section to your project's CLAUDE.md:

```markdown
### Orchestrator Role Mapping

| Role          | Agent              | Notes                          |
|---------------|--------------------|--------------------------------|
| `reviewer`    | `my-code-reviewer` | Project-specific review rules  |
| `implementer` | (default)          |                                |
```

### Writing a Plan Document

Plan documents are markdown files that describe the implementation work for an agent. See `tasks/example-prompt.md` for the expected format. Key guidelines:

- Break the work into numbered phases
- Each phase should be independently buildable and reviewable
- Include acceptance criteria the agent can verify
- Reference specific files and paths where possible

## Troubleshooting

**Server unreachable when launching**
The coordination server must be running before you launch an agent. Start it with `cd server && npm run dev` and verify with `curl http://localhost:9100/health`.

**Shell scripts fail on Windows**
The scripts require a Bash-compatible shell. Use Git Bash (included with Git for Windows) or WSL. The `.gitattributes` file ensures scripts keep LF line endings.

**Docker Compose not found**
Install Docker Desktop (includes Compose v2) or install the standalone `docker-compose`. The scripts detect both `docker compose` (plugin) and `docker-compose` (standalone).

**"BARE_REPO_PATH is not set" or similar**
Edit your `scaffold.config.json` file and set all required paths. Run `./launch.sh --dry-run` to verify your configuration.

**Build timeouts**
The default UBT lock timeout is 600000ms (10 minutes). For large projects, increase `server.ubtLockTimeoutMs` in `scaffold.config.json`.

**Agent seems stuck**
Check container logs: `docker compose --project-name claude-<agent-name> -f container/docker-compose.yml logs -f`. The agent has a `MAX_TURNS` limit (default 200) after which it will stop.

**Port conflict on 9100**
Change `server.port` in `scaffold.config.json` and restart the server.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Ensure the server builds and tests pass: `cd server && npm run typecheck && npm run build && npm test`
4. Ensure shell scripts pass syntax checks: `bash -n launch.sh && bash -n setup.sh && bash -n status.sh`
5. Submit a pull request

## License

MIT
