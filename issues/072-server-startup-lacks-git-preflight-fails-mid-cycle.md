# 072 — Server startup performs no git preflight; a git-less environment fails mid-FSM-cycle, not at boot

**Observed 2026-08-16 (piste-perfect).** The coordination server was restarted (by an agent session) from
an environment without git on PATH. It came up healthy — `/health` green, DB pool connected — and served
requests normally until the first endpoint that shells out to git:

- `POST /sync/plans` → `Failed to resolve HEAD in exterior repo: Command failed: git -C <exterior> rev-parse HEAD`
- `POST /tasks` (plan mode) → 422 `sourcePath ... not found on branch docker/<project>/current-root` — a
  MISLEADING message: the path existed; the server's bare-repo git probe failed and was reported as absence.

The dangerous part is what did NOT get exercised: integration, branch ops, and any completing container's
task transition also shell git. Had a task been mid-flight, the failure would have landed at integration
time — producing the stuck-mid-state class issue 070 describes — instead of at a cheap idempotent endpoint.

**Recovery used:** direct fast-forward push of `current-root` into the bare repo (bypassing /sync/plans),
then a server bounce from a git-capable shell. Both worked; neither should be necessary.

**Proposed fixes, in preference order:**

1. **Startup preflight**: at boot, resolve `git --version` and run one `rev-parse HEAD` against each
   configured project's exterior repo and bare repo. Refuse to listen (or listen with a loud degraded
   banner on `/health`) if any fails. A server that will fail on git must say so at boot, not at the first
   unlucky request.
2. **Honest error attribution**: anywhere a git child-process failure is folded into a domain answer
   ("path not found", "unknown branch"), surface the exec failure distinctly. The 422 above cost real
   diagnosis time because it asserted a false fact about the repository.
3. **Documented start path**: a `start.sh`/`npm run` wrapper that sets or verifies the environment
   (PATH incl. git), so "how the server was started" stops mattering. Agent-driven restarts are now a
   normal occurrence and inherit whatever impoverished environment the agent's spawn context had.
