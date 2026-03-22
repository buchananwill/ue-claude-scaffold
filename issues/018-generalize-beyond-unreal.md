---
title: "Generalize scaffold beyond Unreal Engine"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: open
---

# Generalize scaffold beyond Unreal Engine

## Context

The scaffold has grown from a UBT-serialization workaround into a multi-agent project management system with dependency
graphs, critical-path solving, and auditable logging. The UE-specific parts are now a minority of the surface area. This
issue tracks the structural changes needed to make the scaffold project-agnostic while keeping UE as a first-class
configuration.

## What changes

### 1. Build system becomes a pluggable strategy, not a hardcoded pipeline

Today, every build routes through the UBT lock, the staging worktree sync, and the host-side script runner. For a
Node.js or Rust project, none of that applies — the container can `npm run build` or `cargo build` directly.

**Config change** — add `build.strategy` to `scaffold.config.json`:

```jsonc
{
  "build": {
    // "external" = current UE behavior (hook intercept → host build → UBT lock)
    // "local"    = container builds in-situ (no hooks, no lock, no staging worktree)
    "strategy": "external",

    // Only relevant when strategy = "external"
    "scriptPath": "Scripts/build.py",
    "testScriptPath": "Scripts/run_tests.py",
    "lockTimeoutMs": 600000,
    "ubtRetryCount": 5,
    "ubtRetryDelayMs": 30000,
    "buildTimeoutMs": 660000,
    "testTimeoutMs": 700000,

    // Only relevant when strategy = "local"
    "localBuildCommand": "npm run build",
    "localTestCommand": "npm test"
  }
}
```

**Hook injection becomes conditional.** `launch.sh` reads `build.strategy`:

- `"external"` → inject `intercept_build_test.sh` and `block-push-passthrough.sh` into container hooks (current
  behavior).
- `"local"` → do not inject build hooks. The container runs build commands natively. The UBT lock endpoints still exist
  on the server but are unused.

**Server-side** — `/build` and `/test` endpoints remain available for external-strategy projects. No code removed, just
not called when strategy is local.

**Agent definitions** — the implementer's "do not skip builds" and "build.py --summary" instructions are UE-specific.
These belong in a project-level instruction file, not baked into the agent definition. See §3 below.

### 2. Project-type presets replace hardcoded UE assumptions

Instead of a single `engine` config block, support project-type presets that configure defaults:

```jsonc
{
  "project": {
    "name": "MyProject",
    "path": "/path/to/project",
    "type": "unreal"  // "unreal" | "node" | "rust" | "generic"
  }
}
```

Each preset implies:

| Setting               | `unreal`                 | `node`                   | `rust`                   | `generic`                |
|-----------------------|--------------------------|--------------------------|--------------------------|--------------------------|
| `build.strategy`      | `external`               | `local`                  | `local`                  | `local`                  |
| Build hooks injected  | yes                      | no                       | no                       | no                       |
| UBT lock active       | yes                      | no                       | no                       | no                       |
| `engine` config block | required                 | ignored                  | ignored                  | ignored                  |
| Staging worktree sync | yes                      | no                       | no                       | no                       |
| Default agent type    | `container-orchestrator` | `container-orchestrator` | `container-orchestrator` | `container-orchestrator` |

Presets are defaults — any field can be overridden explicitly. A Node project that still wants external builds (e.g.,
cross-compiling on host) can set `build.strategy: "external"`.

### 3. Agent definitions become project-composable

Currently the implementer agent definition hardcodes UE C++ conventions, `build.py` references, and the `ue-cpp-style`
skill. For a Node project, none of that applies.

**Split agent definitions into layers:**

```
agents/
  core/                          # project-agnostic behavior
    container-orchestrator.md
    container-implementer.md
    container-reviewer.md
    container-tester.md
  overlays/                      # project-specific additions
    unreal/
      implementer-overlay.md     # east-const, ue-cpp-style, build.py, IWYU
      reviewer-overlay.md        # Mass ECS, GC, UObject lifecycle
      safety-overlay.md          # TObjectPtr, MoveTemp, thread safety
      style-overlay.md           # UE naming, UPROPERTY macros
      tester-overlay.md          # Resort.* test naming, automation flags
    node/
      implementer-overlay.md     # ESM/CJS, npm scripts, TypeScript
      reviewer-overlay.md        # async/await patterns, error handling
```

The entrypoint composes the agent definition at launch: `core/{type}.md` + `overlays/{project.type}/{type}-overlay.md`.
Overlays are optional — a `generic` project type uses only the core definitions.

**Config:**

```jsonc
{
  "container": {
    "agentType": "container-orchestrator",
    "overlayDir": "overlays/unreal"   // or omit for no overlay
  }
}
```

### 4. Container instructions become project-scoped

`container/instructions/00-build-loop.md` currently describes UE build routing. This should move to an overlay:

```
container/
  instructions/
    core/                         # always injected
      00-debrief.md
      01-messages.md
      02-task-worker.md
    overlays/
      unreal/
        00-build-loop.md          # UBT queue discipline, build.py routing
      node/
        00-build-commands.md      # npm run build, npm test, no hooks
```

Entrypoint prepends `core/*` then `overlays/{project.type}/*` (sorted by filename within each).

### 5. Config example and setup accommodate non-UE projects

`scaffold.config.example.json` currently has `engine.path`, `engine.version`, `uprojectFile`. These move under the
`unreal` project-type preset:

```jsonc
{
  "project": {
    "name": "MyNodeProject",
    "path": "/path/to/project",
    "type": "node"
  },
  "build": {
    "strategy": "local",
    "localBuildCommand": "npm run build",
    "localTestCommand": "npm test"
  }
  // no "engine" block needed
}
```

`setup.sh` skips bare-repo creation and staging-worktree setup when `build.strategy` is `"local"` — containers work
directly on their branch clone.

### 6. Naming

The repo is currently `ue-claude-scaffold`. The generalized version should drop the UE prefix. Candidates:

- `claude-scaffold`
- `agent-scaffold`
- `orchestrator`

This is a rename, not a rewrite. The existing README and CLAUDE.md update to reflect multi-project support.

## What does NOT change

- Git data flow (bare repo, per-agent branches, current-root integration branch)
- Task queue, dependency graph, priority replan, cycle detection
- Dashboard
- Message board (extended separately in issue 019)
- Agent registration and lifecycle
- File ownership registry
- The coordination server architecture (Fastify + SQLite)

## Migration path

1. Add `build.strategy` and `project.type` to config schema with defaults matching current behavior (`external`,
   `unreal`).
2. Make hook injection conditional in `launch.sh`.
3. Split agent definitions into core + overlays.
4. Split container instructions into core + overlays.
5. Update `setup.sh` to skip UE-specific steps for non-UE project types.
6. All existing UE users see zero behavior change — `"type": "unreal"` is the implicit default.
