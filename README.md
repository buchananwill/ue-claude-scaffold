# @ue-claude/scaffold

Run Claude Code autonomously against Unreal Engine projects. Human authors the plan, container executes it end-to-end,
message board provides live inspectability.

## What Problems Does This Setup Solve?

**1. UBT is a singleton — and agents don't handle that gracefully.**
Unreal Build Tool cannot run concurrently. When an autonomous agent hits a build failure because another build is
already
running, it doesn't queue up and wait — it spirals, retries blindly, or gives up. This scaffold wraps UBT access in a
coordination server with a proper mutex and message board. Agents submit build requests, the server serializes them, and
structured results come back. No agent ever sees a "UBT is already running" error — they just wait their turn.

**2. `--dangerously-skip-permissions` needs an actual safety boundary.**
Autonomous agents need `--dangerously-skip-permissions` to work unattended, but running that on your host machine with
your full filesystem, credentials, and network is asking for trouble. Docker containers provide that boundary. The agent
gets exactly what it needs (a repo clone, the coordination server endpoint, mounted read-only plugins) and nothing it
doesn't (no host filesystem, no credentials beyond Claude auth, no direct network access to your other services). You
get full autonomy without the risk.

## What this is

A scaffold for handing off implementation work to autonomous Claude Code agents running in Docker containers. Designed
for UE developers who already use Claude Code interactively and want to delegate longer tasks.

Unreal Engine builds require the real engine installation on the host — you cannot install UE inside a container. The
coordination server bridges that gap: containers do the coding, the host does the building, and a message board keeps
everything inspectable.

**The workflow:**

1. Design your plan interactively with Claude Code (human in the loop)
2. Commit the plan as a markdown document
3. Launch a container agent — it executes the plan E2E
4. Each phase builds, passes code review, and commits with a debrief audit trail
5. Monitor progress via the coordination server's message board or the dashboard UI

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
#    Required: project.path, engine.path, server.bareRepoPath

# 5. Start the coordination server
cd server && npm run dev

# 6. In another terminal — launch an agent
./launch.sh

# 7. Monitor progress (terminal or browser)
./status.sh --follow
# Or: cd dashboard && npm install && npm run dev
```

## Project Structure

```
ue-claude-scaffold/
├── agents/                    # Claude Code agent definitions
│   ├── container-orchestrator.md   # Default: E2E plan executor
│   ├── container-implementer.md    # Code writer
│   ├── container-reviewer.md       # Code reviewer
│   └── container-tester.md         # Test writer
├── container/                 # Docker container infrastructure
│   ├── Dockerfile
│   ├── docker-compose.example.yml  # Template — copy to docker-compose.yml
│   ├── entrypoint.sh
│   ├── container-settings.json
│   ├── hooks/                 # Claude Code PreToolUse hooks
│   │   ├── intercept_build_test.sh   # Routes build/test to host
│   │   └── block-push-passthrough.sh # Blocks manual git push
│   └── instructions/          # Standing instructions for container agents
│       ├── 00-build-loop.md   # Build routing and UBT queue discipline
│       ├── 01-debrief.md      # Debrief/reporting instructions
│       ├── 02-messages.md     # Message board and monitoring guidance
│       └── 03-task-worker.md  # Task worker mode protocol
├── dashboard/                 # React + Vite monitoring SPA
│   ├── src/                   # TanStack Router + Query, Mantine UI
│   └── package.json
├── plans/                     # Plan documents for container agents
├── scripts/
│   └── ingest-tasks.sh        # Bulk-import task markdown into the queue
├── server/                    # TypeScript coordination server (Fastify)
│   └── src/
├── tasks/                     # Task prompts directory
├── launch.sh                  # Parameterized agent launcher
├── setup.sh                   # First-time setup script
├── status.sh                  # Agent monitoring script
├── stop.sh                    # Stop agent containers (supports --drain)
├── .env.example
├── .gitattributes
├── scaffold.config.example.json
├── LICENSE                    # MIT
└── README.md
```

## How It Works

### Container Agent Architecture

Each container runs a single Claude Code instance in non-interactive (`-p`) mode with a delegated agent type (default:
`container-orchestrator`). The orchestrator:

1. Reads the plan from the task prompt
2. Resolves sub-agents from the project's CLAUDE.md role mapping
3. Delegates each phase to an **implementer** -> verifies build -> delegates to **reviewer**
4. Iterates on failures (max 3 build retries, max 2 review cycles per phase)
5. Commits each phase with a debrief audit document

### Build/Test Routing

Containers don't have Unreal Engine installed. When Claude runs a build or test command, a PreToolUse hook intercepts
it:

1. Commits and pushes current changes to a bare repo
2. Calls the coordination server's `/build` or `/test` endpoint
3. The server syncs changes to a host-side worktree and runs the real build
4. Returns structured output back to the container agent

### Coordination Server

A Fastify + TypeScript server running on the host. Provides:

- **Build/test proxy** -- routes container build requests to the host UE installation
- **Message board** -- SQLite-backed pub/sub for agent progress reporting
- **Agent registry** -- tracks active agents and their status
- **UBT lock** -- serializes build tool access with priority queue (multi-agent support)
- **Build history** -- queryable record of all builds with duration and outcome
- **File ownership** -- tracks which agent owns which files during task execution
- **Search** -- full-text search across tasks, messages, and agents
- **Coalesce** -- system-wide coordination for graceful shutdown (pause pumps, release files)

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

The bare repo acts as a shared intermediary. The container clones from it on startup and pushes changes back when a
build is requested. The server then fetches those changes into a staging worktree on the host where the real UE build
tools run.

## Configuration

### `.env`

Secrets and per-launch parameters. Created from `.env.example` by `setup.sh`. Structural configuration (paths, ports,
build scripts) lives in `scaffold.config.json`.

| Variable                  | Required | Default                  | Description                                |
|---------------------------|----------|--------------------------|--------------------------------------------|
| `CLAUDE_CREDENTIALS_PATH` | Yes*     | —                        | Path to `.credentials.json` for OAuth auth |
| `ANTHROPIC_API_KEY`       | Yes*     | —                        | API key for token-based auth               |
| `AGENT_NAME`              | No       | `agent-1`                | Agent identifier                           |
| `WORK_BRANCH`             | No       | `main`                   | Git branch for the agent to work on        |
| `AGENT_TYPE`              | No       | `container-orchestrator` | Agent definition to use                    |
| `MAX_TURNS`               | No       | `200`                    | Max Claude Code turns before stopping      |

*One of `CLAUDE_CREDENTIALS_PATH` or `ANTHROPIC_API_KEY` is required.

### `scaffold.config.json`

Structural configuration. Created from `scaffold.config.example.json` by `setup.sh`.

| Field                        | Description                                   |
|------------------------------|-----------------------------------------------|
| `project.name`               | Your UE project name                          |
| `project.path`               | Absolute path to the project                  |
| `project.uprojectFile`       | The `.uproject` filename                      |
| `engine.path`                | Absolute path to the UE engine                |
| `engine.version`             | UE version string (e.g. `"5.7"`)              |
| `build.scriptPath`           | Build script path relative to project root    |
| `build.testScriptPath`       | Test script path relative to project root     |
| `build.defaultTestFilters`   | Array of default test filter strings          |
| `plugins.readOnlyMounts`     | Plugin paths to mount read-only in containers |
| `container.agentType`        | Default agent type for containers             |
| `container.maxTurns`         | Max turns for the agent                       |
| `container.seedBranch`       | Seed branch for fresh containers              |
| `server.port`                | Coordination server port                      |
| `server.ubtLockTimeoutMs`    | Timeout for UBT lock acquisition              |
| `server.stagingWorktreeRoot` | Path to the host-side staging worktree        |
| `server.bareRepoPath`        | Path to the bare repo                         |

## Scripts

### `launch.sh`

Parameterized launcher for container agents.

```bash
# Launch an agent (tasks come from the task queue)
./launch.sh

# Explicit agent name
./launch.sh --agent-name agent-2

# Preview what would happen without launching
./launch.sh --dry-run

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

### `stop.sh`

Stop running agent containers.

```bash
# Stop all agent containers
./stop.sh

# Stop a specific agent
./stop.sh --agent agent-1

# Graceful drain — pause pumps, wait for in-flight tasks, stop containers
./stop.sh --drain

# Drain with custom timeout (default 600s)
./stop.sh --drain --timeout 300
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

The `agents/` directory contains agent definitions used by the container. When running in a container, agent definitions
are automatically mounted from the scaffold's `agents/` directory. For interactive (non-container) Claude Code use,
install them manually:

```bash
cp agents/*.md ~/.claude/agents/
```

### Available Agent Types

| Type                     | Description                                                                                                              |
|--------------------------|--------------------------------------------------------------------------------------------------------------------------|
| `container-orchestrator` | Default. Executes a pre-authored plan E2E — delegates to sub-agents, no human approval gates.                            |
| `container-implementer`  | Writes code according to a plan or fix instructions. Builds after each change and iterates until clean.                  |
| `container-reviewer`     | Reviews implementation against the original spec and project style. Uses confidence scoring to minimize false positives. |
| `container-tester`       | Writes tests for an implementation, runs them, and iterates until passing.                                               |

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

Plan documents are markdown files that describe the implementation work for an agent. See `tasks/example-prompt.md` for
the expected format. Key guidelines:

- Break the work into numbered phases
- Each phase should be independently buildable and reviewable
- Include acceptance criteria the agent can verify
- Reference specific files and paths where possible

## Troubleshooting

**Server unreachable when launching**
The coordination server must be running before you launch an agent. Start it with `cd server && npm run dev` and verify
with `curl http://localhost:9100/health`.

**Shell scripts fail on Windows**
The scripts require a Bash-compatible shell. Use Git Bash (included with Git for Windows) or WSL. The `.gitattributes`
file ensures scripts keep LF line endings.

**Docker Compose not found**
Install Docker Desktop (includes Compose v2) or install the standalone `docker-compose`. The scripts detect both
`docker compose` (plugin) and `docker-compose` (standalone).

**"BARE_REPO_PATH is not set" or similar**
Edit your `scaffold.config.json` file and set all required paths. Run `./launch.sh --dry-run` to verify your
configuration.

**Build timeouts**
The default UBT lock timeout is 600000ms (10 minutes). For large projects, increase `server.ubtLockTimeoutMs` in
`scaffold.config.json`.

**Agent seems stuck**
Check container logs: `docker compose --project-name claude-<agent-name> -f container/docker-compose.yml logs -f`. The
agent has a `MAX_TURNS` limit (default 200) after which it will stop.

**Port conflict on 9100**
Change `server.port` in `scaffold.config.json` and restart the server.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Ensure the server builds and tests pass: `cd server && npm run typecheck && npm run build && npm test`
4. Ensure shell scripts pass syntax checks:
   `bash -n launch.sh && bash -n setup.sh && bash -n status.sh && bash -n stop.sh`
5. Submit a pull request

## License

MIT
