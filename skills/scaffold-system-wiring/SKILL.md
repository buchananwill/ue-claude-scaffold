---
name: scaffold-system-wiring
description: Agent resolution table, build verification commands, and file targets for the scaffold development orchestrator running inside a Docker container against the ue-claude-scaffold project.
axis: environment
---

# Scaffold System Wiring

Environment configuration for the scaffold orchestrator running inside a Docker container against the ue-claude-scaffold project.

## Agent Resolution

| Role              | Agent                              | Purpose                                               |
|-------------------|------------------------------------|-------------------------------------------------------|
| `implementer`     | `scaffold-implementer`             | Writes TypeScript, shell scripts, agent/skill markdown |
| `style-reviewer`  | `scaffold-style-reviewer`          | ESM, Fastify patterns, naming, Mantine conventions    |
| `safety-reviewer` | `scaffold-safety-reviewer`         | SQL injection, input validation, shell injection      |
| `reviewer`        | `scaffold-correctness-reviewer`    | Logic, spec compliance, async correctness, API contracts |
| `tester`          | `scaffold-tester`                  | Writes and runs Node.js built-in test runner tests    |
| `decomp-reviewer` | `scaffold-decomposition-reviewer`  | File bloat, module sprawl, DRY violations             |

## Review Agent Mandates

Each reviewer assesses only its own dimension. Do not ask the style reviewer about correctness, or the safety reviewer about naming. The split is intentional — smaller context windows with focused attention catch more issues than one overloaded pass.

## Build Verification

Before a phase passes, the implementer must demonstrate a successful build:

- **Server changes**: `cd server && npm run typecheck && npm run build`
- **Dashboard changes**: `cd dashboard && npm run build`
- **Shell scripts**: `bash -n <script>` for each modified script
- **Tests**: `npm test` in `server/` (or `npx tsx --test <specific-file>`)

## Decomposition File Targets

The decomposition reviewer targets `.ts`, `.tsx`, and `.sh` files (not `.h`/`.cpp`). Collect changed files with:

```bash
git diff --name-only <base>...HEAD -- '*.ts' '*.tsx' '*.sh'
```

