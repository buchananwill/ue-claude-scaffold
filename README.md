# @ue-claude/scaffold

Run Claude Code autonomously against Unreal Engine projects. Human authors the plan, container executes it end-to-end, message board provides live inspectability.

## What this is

A turnkey scaffold for handing off implementation work to autonomous Claude Code agents running in Docker containers. Designed for UE developers who already use Claude Code interactively and want to delegate longer tasks.

**The workflow:**
1. Design your plan interactively with Claude Code (human in the loop)
2. Commit the plan as a markdown document
3. Launch a container agent — it executes the plan E2E
4. Each phase builds, passes code review, and commits with a debrief audit trail
5. Monitor progress via the coordination server's message board

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Node.js](https://nodejs.org/) 22+
- [Git](https://git-scm.com/)
- A Claude authentication method:
  - **OAuth** (Claude Pro/Max subscription) — mount your `~/.claude/.credentials.json`
  - **API key** — set `ANTHROPIC_API_KEY` environment variable
- An Unreal Engine installation (for the host-side build system)

## Quick Start

```bash
# Clone
git clone https://github.com/your-org/ue-claude-scaffold.git
cd ue-claude-scaffold

# Configure
cp .env.example .env
cp scaffold.config.example.json scaffold.config.json
# Edit both files with your project paths

# Install agent definitions (only needed for interactive use outside containers)
# Container agents are automatically mounted via docker-compose.
cp agents/*.md ~/.claude/agents/

# Start the coordination server
cd server && npm install && npm run dev

# In another terminal — launch an agent
./launch.sh --plan path/to/your-plan.md --branch feature/my-feature
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
├── server/                    # TypeScript coordination server (Phase 2)
│   └── src/
├── .env.example
├── scaffold.config.example.json
├── LICENSE                    # MIT
└── README.md
```

## How It Works

### Container Agent Architecture

Each container runs a single Claude Code instance in non-interactive (`-p`) mode with a delegated agent type (default: `container-orchestrator`). The orchestrator:

1. Reads the plan from the task prompt
2. Resolves sub-agents from the project's CLAUDE.md role mapping
3. Delegates each phase to an **implementer** → verifies build → delegates to **reviewer**
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

- **Build/test proxy** — routes container build requests to the host UE installation
- **Message board** — SQLite-backed pub/sub for agent progress reporting
- **Agent registry** — tracks active agents and their status
- **UBT lock** — serializes build tool access (for future multi-agent support)

## Configuration

### `.env`

Secrets and host-specific paths. See `.env.example`.

### `scaffold.config.json`

Structural configuration. See `scaffold.config.example.json`.

Key sections:
- `build.scriptPath` — path to your build script relative to project root
- `plugins.readOnlyMounts` — plugins to mount into the container
- `claudeMdPatches.pathRemaps` — host→container path substitutions for CLAUDE.md
- `claudeMdPatches.agentSubstitutions` — agent replacements for the container environment

## Agent Definitions

The `agents/` directory contains agent definitions used by the container. When running in a container, agent definitions are automatically mounted from the scaffold's `agents/` directory. For interactive (non-container) Claude Code use, install them manually:

```bash
cp agents/*.md ~/.claude/agents/
```

### `container-orchestrator`

The default agent type for container execution. Executes a pre-authored plan autonomously — no human approval gates. Each phase must build and pass code review before advancing.

### Customising for your project

Add an `### Orchestrator Role Mapping` section to your project's CLAUDE.md:

```markdown
### Orchestrator Role Mapping

| Role          | Agent              | Notes                          |
|---------------|--------------------|--------------------------------|
| `reviewer`    | `my-code-reviewer` | Project-specific review rules  |
| `implementer` | (default)          |                                |
```

## License

MIT
