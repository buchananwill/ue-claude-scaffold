---
name: proc-geo-environment
description: Use for any agent working on the procedural-geometry-ideas codebase. Defines the pnpm workspace layout, per-package build/test commands, dependency build order, and what runs where. Container execution.
axis: environment
---

# Procedural Geometry Ideas — Environment

You are working on `procedural-geometry-ideas`, a **pnpm workspaces monorepo** of pure
TypeScript packages plus a Next.js demo app. There is no Unreal Engine, no C++, and no host
build forwarding — everything compiles and tests inside your container.

## Repository Layout

```
procedural-geometry-ideas/
  packages/
    core/            ← @proc-geo/core — geometry solver library. Pure TS, no React.
    test-fixtures/   ← @proc-geo/test-fixtures — named polygon fixtures
    dashboard/       ← @proc-geo/dashboard — React component library (Mantine, Konva, Zustand)
  apps/
    demo/            ← @proc-geo/demo — Next.js App Router demo app
  docs/notes/        ← design specs and algorithm notes
  pnpm-workspace.yaml
  tsconfig.base.json ← shared compiler options
```

Dependency graph: `demo → dashboard → core`, `demo → test-fixtures → core`,
`core ←(devDep) test-fixtures`.

## pnpm Is the Package Manager — Never npm or yarn

The container image ships pnpm 10.14.0 via corepack, matching the committed
`pnpm-lock.yaml` (lockfileVersion 9.0). Use `pnpm` directly — it is on `PATH`.

**Do not run `npm install`, `npm test`, or `npm run build`.** npm cannot read
`pnpm-workspace.yaml`, will not link workspace packages, and writes a competing
`package-lock.json` that was deliberately deleted from this repo (commit `e2544d4`).
A stray lockfile is a review-blocking defect.

> Any instruction you may have seen about a broken pnpm shim requiring
> `node ~/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs` is a **host Windows**
> workaround from the repo's `CLAUDE.md`. It does not apply in your Linux container.
> Plain `pnpm` is correct here.

## First Command in a Fresh Workspace

Your workspace is a fresh git clone with **no `node_modules`**. Before building or testing
anything:

```bash
pnpm install --frozen-lockfile
```

Use `--frozen-lockfile` so the lockfile is honoured rather than silently rewritten. If it
fails because the lockfile genuinely needs updating, that is a real finding — report it,
do not paper over it by dropping the flag.

## Build and Test Commands

Build order matters — `core` must build before its dependents:

```bash
pnpm build                                  # all packages, correct order
pnpm --filter @proc-geo/core build          # single package
pnpm --filter @proc-geo/test-fixtures build
pnpm --filter @proc-geo/dashboard build
```

Tests (see the `proc-geo-test-format` skill for how to write them):

```bash
pnpm test                                   # runs @proc-geo/core's Jest suite
pnpm --filter @proc-geo/core test
pnpm --filter @proc-geo/core test -- --testPathPatterns=core-functions
```

Lint:

```bash
pnpm lint                                   # ESLint over the demo app only
```

Type-checking has no dedicated script — it happens as part of `build` (tsup emits
declarations). To type-check without a full build, run `pnpm --filter <pkg> exec tsc --noEmit`.

## Your Verification Gate

Your TDD loop's final action must be a **passing `pnpm --filter @proc-geo/core test` plus a
successful `pnpm build`**, run in that order, with output shown. A change that compiles but
has not been exercised by the Jest suite is not finished.

If you touched `packages/dashboard/` or `apps/demo/`, add `pnpm lint`.

## What Runs Where

There is **no host build forwarding** for this project. No `/build` or `/test` coordination
server call, no UBT lock, no staging worktree, and no `Scripts/build.py`. If you find yourself
reaching for any of those, you have loaded the wrong mental model — this is a self-contained
TypeScript build.

## Key Conventions

- **ESM + CJS dual output** via tsup; barrel export at each package's `src/index.ts`.
- **Workspace imports** resolve by package name (`@proc-geo/core`), never by relative path
  across a package boundary.
- **`@proc-geo/core` has no React or browser dependency.** Its only runtime dep is `loglevel`.
  Never import React, Mantine, Konva, or anything DOM-flavoured into `packages/core/`.
- **Design specs live in `docs/notes/`** as markdown. Treat the spec named in your task as the
  behaviour contract.
</content>
</invoke>
