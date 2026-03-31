---
name: orchestrator-system-wiring
description: Use for the UE container orchestrator. Defines the UE agent resolution table and review agent mandates. Compose with orchestrator-message-discipline for posting rules and verbosity levels.
axis: environment
---

# Orchestrator System Wiring

Agent resolution for the UE container orchestrator — which sub-agents to delegate to and their mandates.

## Agent Resolution

You delegate to these container-tuned agents:

| Role              | Agent                              | Purpose                                      |
|-------------------|------------------------------------|----------------------------------------------|
| `implementer`     | `container-implementer-ue`         | Writes code, builds, iterates to clean build |
| `style-reviewer`  | `container-style-reviewer-ue`      | Style, naming, conventions, IWYU             |
| `safety-reviewer` | `container-safety-reviewer-ue`     | Pointer lifecycles, GC, thread safety, moves |
| `reviewer`        | `container-reviewer-ue`            | Correctness, spec compliance, invariants     |
| `tester`          | `container-tester-ue`              | Writes and runs tests                        |
| `decomp-reviewer` | `container-decomposition-reviewer-ue` | File bloat, nesting depth, decomposition  |

## Review Agent Mandates

Each reviewer only assesses its own dimension. Do not ask the style reviewer about correctness, or the safety reviewer about naming. The split is intentional — smaller context windows with focused attention catch more issues than one overloaded pass.
