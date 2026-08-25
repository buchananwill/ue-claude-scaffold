---
title: "clang-format absent from the UE container image, so the mandatory style gate cannot run"
priority: medium
reported-by: interactive-session
date: 2026-07-31
---

# clang-format absent from the UE container image

## What happened

Task 209 (`piste-perfect`, agent-1) completed its implementation and reported:

> `Scripts/format.py` could not run: clang-format is not installed in this container.

The build succeeded and the task proceeded to review regardless.

## Why it matters

`Scripts/format.py` is not optional tidying in this project. It is a Slate- and reflection-aware
wrapper around `clang-format` that fences `SNew`/`SAssignNew` declarative trees and long
`UPROPERTY`/`UFUNCTION` invocations before formatting, because bare `clang-format` reflows both into
forms that are respectively unreadable and rejected by UHT. The project's `CLAUDE.md` mandates it for
every modified `.h`/`.cpp`, and the `piste-perfect-coordination` skill lists it as a mandatory gate
after a successful build.

The consequence of it silently not running is not a broken build — it is formatting drift that lands
in the repository and is only discovered later, on a host-side worktree, by whoever next runs the
wrapper over those files. Every container task touching C++ in this project is affected, so the drift
accumulates per task rather than being a one-off.

## Suggested fix

Install `clang-format` in the UE container image. The project compiles under the Redpoint Clang fork
(LLVM 19.1.7 per the host toolchain), so matching that major version avoids the wrapper producing a
different result inside the container than on the host — a version skew here would be worse than the
current absence, because it would produce churn that alternates between two formattings.

## Interim mitigation

None available container-side. The gate has to be run host-side after integration, which means it is
a manual step that is easy to forget and is not represented anywhere in the task lifecycle.

## Worth considering

`format.py` failing to find `clang-format` currently does not fail the task. If the style gate is
genuinely mandatory, a missing formatter is arguably a task-blocking environment error rather than a
warning the implementer notes and moves past — otherwise the mandate is advisory in practice.

## Resolved 2026-08-12 — installed in the image

[container/Dockerfile](../container/Dockerfile) now installs `clang-format` pinned to **19.1.7**,
matching the host toolchain. It comes from the PyPI wheel (the only way to pin an exact patch
version) in a separate build stage, so `python3-pip` never reaches the runtime image: the binary is
3.9MB and the final image grows ~5MB rather than ~113MB. `clang-format --version` was added to the
Dockerfile's existing smoke-test `RUN`, so a future base-image change cannot silently drop it again.

The version-skew hazard raised above was measured, not assumed. The host runs Redpoint's LLVM fork
and the wheel ships upstream, both 19.1.7. Formatting a deliberately mangled project header through
each — 98 lines reformatted — produced **byte-identical** output. No skew, so no alternating-churn
risk.

Two things this deliberately does not address:

- **The advisory-vs-blocking question in the section above is still open.** `format.py` raising
  `FileNotFoundError` is now unlikely, but nothing makes a skipped format pass fail a task. That is
  an agent/skill-layer decision, not a Dockerfile one.
- **Enforcement remains container-side and agent-driven.** Running the gate host-side in the build
  intercept was considered and rejected: the transport force-pushes (`forward_build_test.sh`) and the
  container only re-syncs between tasks, so a host-side formatting commit would be silently
  obliterated by the agent's next build. Making it work would need a post-call `fetch`/`reset` in the
  transport plus a second writer to the agent branch, and would mutate the workspace under the agent
  mid-task — breaking `Edit`'s read-then-match contract on every file the formatter touched.
