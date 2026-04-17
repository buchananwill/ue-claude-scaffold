---
name: orchestrator-system-wiring
description: Use for the UE container orchestrator. Defines the UE agent resolution table, review agent mandates, and the terminal style sweep. Compose with orchestrator-message-discipline for posting rules and verbosity levels.
axis: environment
---

***ACCESS SCOPE: ubt-build-hook-interceptor***

# Orchestrator System Wiring

Agent resolution for the UE container orchestrator — which sub-agents to delegate to and their mandates.

## Agent Resolution

You delegate to these container-tuned agents:

| Role              | Agent                                 | Purpose                                      |
|-------------------|---------------------------------------|----------------------------------------------|
| `implementer`     | `container-implementer-ue`            | Writes code, builds, iterates to clean build |
| `safety-reviewer` | `container-safety-reviewer-ue`        | Pointer lifecycles, GC, thread safety, moves |
| `reviewer`        | `container-reviewer-ue`               | Correctness, spec compliance, invariants     |
| `tester`          | `container-tester-ue`                 | Writes and runs tests                        |
| `decomp-reviewer` | `container-decomposition-reviewer-ue` | File bloat, nesting depth, decomposition     |
| `style-sweep`     | `container-style-sweep-ue`            | Terminal style pass: edit-in-place, build, test, single commit |

Note: there is **no per-phase `style-reviewer` row** in this wiring. Style normalisation runs once at the end of the plan as the terminal style sweep (see Style Sweep Commands below, and the Final Stage — Style Sweep section of `orchestrator-phase-protocol`).

## Review Agent Mandates

Each reviewer only assesses its own dimension. Do not ask the safety reviewer about naming — naming lives under style, which is handled by the terminal sweep, not per-phase review. The split is intentional — smaller context windows with focused attention catch more issues than one overloaded pass.

## Style Sweep Commands

The terminal style sweep (`style-sweep` → `container-style-sweep-ue`) sources its build and test commands from the environment skills it composes — see that agent's definition for the exact commands. Your delegation prompt to the sweep provides:

- The git diff range (`<branch-base>..HEAD`)
- The full list of changed files produced by `git diff <branch-base>..HEAD --name-only`, filtered to `.h` / `.cpp`
- The commit message format: `Style sweep: normalize <N> files post-plan`

Do not supply build or test commands in the delegation prompt — the sweep already loads `container-build-routing`, `container-git-build-intercept`, `ue-engine-mount`, `lint-hook-awareness`, and `project-test-knowledge` from its skill composition.
