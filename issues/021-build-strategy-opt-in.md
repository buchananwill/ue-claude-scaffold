---
title: "Build lock opt-in: local vs external build strategies"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: open
---

# Build lock opt-in

## Problem

The entire build pipeline — hook interception, UBT lock acquisition, staging worktree sync, host-side script execution —
exists because Unreal Build Tool cannot run inside a Docker container and cannot run concurrently. For Node.js, Rust,
Go, Python, or any project with a container-native toolchain, this infrastructure is unnecessary overhead and active
friction.

A Node project should `npm run build` directly inside the container. No hooks, no lock, no staging worktree, no host
roundtrip.

## Design

### 1. Two build strategies

| Strategy   | When to use                                                                | Build location                | Lock           | Hooks injected                                         | Staging worktree |
|------------|----------------------------------------------------------------------------|-------------------------------|----------------|--------------------------------------------------------|------------------|
| `external` | Toolchain can't run in container (UE) or must serialize (single-writer DB) | Host, via coordination server | Yes (UBT lock) | `intercept_build_test.sh`, `block-push-passthrough.sh` | Yes              |
| `local`    | Toolchain runs natively in container                                       | Inside container              | No             | None                                                   | No               |

### 2. Config

```jsonc
{
  "build": {
    "strategy": "local",          // "external" | "local"

    // local-strategy fields
    "localBuildCommand": "npm run build",
    "localTestCommand": "npm test",

    // external-strategy fields (only used when strategy = "external")
    "scriptPath": "Scripts/build.py",
    "testScriptPath": "Scripts/run_tests.py",
    "lockTimeoutMs": 600000,
    "ubtRetryCount": 5,
    "ubtRetryDelayMs": 30000,
    "buildTimeoutMs": 660000,
    "testTimeoutMs": 700000
  }
}
```

### 3. launch.sh changes

```bash
STRATEGY=$(jq -r '.build.strategy // "external"' "$CONFIG_FILE")

if [ "$STRATEGY" = "external" ]; then
  # Current behavior: inject hooks, require bare repo, configure staging worktree
  inject_build_hooks
  ensure_bare_repo
  ensure_staging_worktree
else
  # Local strategy: no hooks, container builds natively
  # Still need bare repo for branch model (clone/push)
  ensure_bare_repo
  # No staging worktree needed
  # No hook injection
fi
```

### 4. Container instructions adapt

For `local` strategy, `container/instructions/overlays/node/00-build-commands.md`:

```markdown
## Build commands

Run builds and tests directly in this container:

- Build: `npm run build`
- Test: `npm test`

There is no build hook interception. Commands execute locally. You can run them as many times as needed.
```

For `external` strategy, the existing `00-build-loop.md` continues to apply.

### 5. Server endpoints remain available

The `/build`, `/test`, and `/ubt/*` endpoints stay on the server regardless of strategy. They are simply not called when
strategy is `local`. This keeps the server simple and allows mixed-strategy deployments (e.g., one UE project and one
Node project sharing the same coordination server).

### 6. Build history for local strategy

Local builds don't route through the server, so build history isn't automatically recorded. Two options:

**Option A: Agent self-reports.** Add a `POST /builds/report` endpoint that agents call after local builds:

```json
{
  "type": "build",
  "durationMs": 4500,
  "success": true,
  "output": "Build completed successfully",
  "stderr": ""
}
```

Agent identified via `X-Agent-Name` header. This keeps build history complete regardless of strategy.

**Option B: Skip history for local builds.** Build history is primarily useful for UBT wait-time estimation. Local
builds don't queue, so the history is less valuable. The dashboard can show "local build" without timing data.

Recommendation: **Option A** — the data is cheap to collect and valuable for understanding agent productivity across
project types.

### 7. Git push model for local strategy

With `external` strategy, the build hook auto-commits and pushes to the bare repo before building. With `local`
strategy, this auto-push doesn't happen. The container still pushes to the bare repo, but through the normal git flow:

- Agent makes changes, commits, pushes to `docker/{agent-name}` on the bare repo.
- No force-push blocking hook needed — there is no hook infrastructure at all.
- The `block-push-passthrough.sh` hook is not injected, so agents can push freely.

The branch model (per-agent branches, current-root integration) is unchanged.

## Migration

1. Add `build.strategy` to config schema, defaulting to `"external"` for backward compatibility.
2. Gate hook injection in `launch.sh` on strategy value.
3. Add `localBuildCommand` and `localTestCommand` to config schema.
4. Create `container/instructions/overlays/node/00-build-commands.md`.
5. Optionally add `POST /builds/report` endpoint.
6. Existing UE setups see no change — `"external"` is the default.

## Dependencies

- Issue 018 (generalization) — this is the build-system component of the generalization effort.
