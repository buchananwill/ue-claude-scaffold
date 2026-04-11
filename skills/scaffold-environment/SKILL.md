---
name: scaffold-environment
description: Use for any agent working on the ue-claude-scaffold codebase. Defines where things live, how to build/test/typecheck, and what tools are available. Non-container interactive execution.
axis: environment
---

# Scaffold Environment

You are working on ue-claude-scaffold — a scaffold for running autonomous Claude Code agents against Unreal Engine projects.

## Repository Layout

```
ue-claude-scaffold/
  server/           ← Fastify + TypeScript coordination server
  dashboard/        ← React + Vite + Mantine monitoring SPA
  container/        ← Docker entrypoint, hooks, compose config, standing instructions
  agents/           ← Markdown agent definitions (YAML frontmatter + system prompt)
  skills/           ← Markdown SKILL.md files (YAML frontmatter + skill content)
  plans/            ← Plan documents and design analysis
  issues/           ← Issue markdown files with frontmatter
  scripts/          ← Utility shell scripts
  launch.sh         ← Launch container agent
  setup.sh          ← First-time setup
  status.sh         ← Monitor agent progress
  stop.sh           ← Stop running agents
```

## Build Commands

### Server (`server/`)

```bash
cd server
npm run typecheck    # Type-check without emitting
npm run build        # TypeScript compile to dist/
npm test             # Run all tests (Node.js built-in test runner via tsx)
npm run test:coverage # Tests with c8 coverage
npx tsx --test src/routes/<file>.test.ts  # Run a single test file
npm run dev          # Start dev server with hot reload
```

### Dashboard (`dashboard/`)

```bash
cd dashboard
npm run build        # Type-check + production build
npm run dev          # Start Vite dev server
npm run preview      # Preview production build
```

### Shell Scripts

```bash
bash -n launch.sh    # Validate syntax (no execution)
bash -n setup.sh
bash -n status.sh
bash -n stop.sh
```

## Key Conventions

- **ESM throughout**: all `.ts` imports use `.js` extensions (`import { foo } from './bar.js'`)
- **DB schema**: defined in `server/src/schema/tables.ts`, indexed by `server/src/schema/index.ts`. Migrations live in `server/drizzle/` and apply via `npm run db:migrate` (which runs `src/migrate.ts`). PGlite for dev and tests; node-postgres for prod via `DATABASE_URL`.
- **Config split**: `scaffold.config.json` (structural, not committed) + `.env` (secrets, not committed). Examples provided as `*.example.*` files.
- **Tests**: each subtree owns its own test stack. Read `package.json` and `tsconfig.json` in the subtree you're working in for the authoritative test runner, scripts, and helpers — do not assume a framework.
- **Agent/skill format**: Markdown with YAML frontmatter. Skills have `name`, `description`, `axis` fields. Agents have `name`, `description`, `model`, `color`, `tools` fields.
