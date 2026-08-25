---
title: "Test runs mis-report by parsing a concurrent editor's log; timed-out editors are not reaped"
priority: high
reported-by: interactive-session
date: 2026-08-13
---

# Test runs mis-report by parsing a concurrent editor's log; timed-out editors are not reaped

## Incident (piste-perfect, task 217, 2026-08-13 ~12:48–13:58)

A container agent burned most of a review cycle chasing a phantom test crash. Verified sequence
from `staging/agent-1/Saved/Logs`:

1. A test run was launched with the bare filter `Resort` (no trailing dot). In this project that
   filter substring-matches `ResortBehaviourFunctionalTest` — two Tier-5 functional *level* tests at
   ~5 min each — plus the whole 2419-test suite.
2. That run exceeded the 600 s harness timeout. The harness stopped waiting and reported, but the
   `UnrealEditor-Cmd.exe` process **kept running for ~65 more minutes** (it exited on its own at
   13:58:26). The timeout kill did not reap it.
3. While the orphan lived, it held the primary log name `PistePerfect_5_7.log`. Every subsequent,
   correctly-filtered agent run (`Resort.Buildable.Pathways`, 66 tests, all passing, exit code 0)
   was shunted by UE to the fallback name `PistePerfect_5_7_2.log` — but `run_tests.py` parses the
   **primary** name, so each report described the orphan's run: `Total: 2419, Passed: 1,
   INCOMPLETE — likely cause: a test crashed the engine`.
4. The agent, told its passing runs were crashes, iterated against a defect that did not exist.

## Defects

- **D1 (server): timeout does not reap the process tree.** `runCommand` in
  `server/src/routes/build.ts` documents tree-kill intent, but the editor demonstrably survived the
  timeout by over an hour. On Windows this needs `taskkill /T` semantics (or Job Objects), and a
  post-timeout verification that the tree is actually gone.
- **D2 (harness contract): the parsed log is not pinned to the spawned process.** `run_tests.py`
  reads `Saved/Logs/<Project>.log` by fixed name. Fix options, best first: pass a unique
  `-Log=<name>.log` / `ABSLOG=` per invocation and parse that file; or detect the `_2` fallback and
  refuse with a "another editor instance is running" error instead of mis-reporting. Either turns a
  silent lie into a loud, actionable failure.
- **D3 (config/default): the default test filter is a known trap.** `run_tests.py` has
  `DEFAULT_FILTER = "Resort"` and the scaffold's `defaultTestFilters` mirrors it. The project's own
  journal documents that bare `Resort` greedily matches the Tier-5 level tests and that sweeps must
  use `"Resort."` **with the trailing dot**. The default should be the safe spelling. (D3's
  run_tests.py half is project-side and will be fixed there; recorded here because
  `defaultTestFilters` lives in scaffold config.)

## Suggested acceptance

A test run that times out leaves no `UnrealEditor-Cmd.exe` alive; a test run whose log cannot be
attributed to its own process fails loudly rather than reporting another process's results; the
shipped default filter for piste-perfect is `Resort.`.
