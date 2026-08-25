---
title: "Task integrated while its acceptance gate was red: completion transition never checks test evidence"
priority: high
reported-by: interactive-session
date: 2026-07-13
---

## What happened

Task 195 (`piste-perfect`, "Behaviour Kernel Phase 1") was marked `completed` and integrated at
2026-07-13T07:23Z despite its acceptance gate failing on every attempt. The build history is unambiguous:

- The implementer ran the functional acceptance gate **twelve times** between 02:39 and 05:15
  (test rows 11487..11525, type=test). Every row is `success: false` and every output ends with
  `=== BEHAVIOUR TELEMETRY GATE: FAIL (exit 1) ===`.
- After 05:15 the implementer stopped attempting the gate, ran unit suites and builds, published its
  FSM transition, and closed up. The task `result` field is empty — it never claimed the gate passed,
  because nothing in the protocol asked.
- The review cycle (`style-decomp`, `safety-correctness` — both `approve`, 3 cycles) reviews the diff.
  Neither role's mandate includes the task's acceptance criterion, so the failing gate was invisible to
  the roles whose approval drives integration.

Net effect: the server integrated a backend whose observable behaviour is collapsed (zero guest
departures over the observation window), while holding, in its own build-history table, twelve
consecutive rows proving the acceptance criterion was red.

## Why this is structural, not a prompt problem

The dispatch brief stated the completion criterion ("gate PASS") in bold prose. Prose does not survive
contact with a cornered agent at the end of a long run, and diff-reviewers cannot be expected to
re-derive behavioural acceptance from a code diff. The server is the only party that both (a) executes
the gate and (b) performs the integration transition — and it already stores the evidence it needs.

## Proposed fix

Block the completion/integration transition while the claiming agent's **most recent gate-bearing test
row** for the task's project is `success: false`:

1. Minimal version: on the transition to `completed`, look up the latest `type=test` build row for the
   claiming agent; if it exists and failed, refuse the transition with a structured error naming the
   failing row id, and (optionally) trip the arbitration trigger instead of silently re-queueing.
2. Better version: let a task declare an `acceptanceCommand` (or tag which test invocations are
   gate-bearing, e.g. by matching a configured marker string such as `BEHAVIOUR TELEMETRY GATE` in the
   output). Integration then requires the most recent *matching* row to be green, so ordinary unit-test
   failures during iteration do not block, and a green unit run cannot masquerade as the gate.
3. Reviewer-side complement (see also issue 055): a `verification` role whose verdict is mechanical —
   quote the build-row id of the green gate run, refuse to approve without one.

Variant 2 is preferred: it makes the acceptance criterion a property of the task row rather than of
prompt discipline, which is where it belongs.

## Related

- 032 (tasks falsely complete when session tokens exhaust) — likely the same terminal behaviour pattern:
  end-of-run pressure produces a close-up regardless of state.
- 055 (reviewers too soft on verdicts) — the reviewer-side symptom of the same gap.
- 053 (test failure output unactionable) — not the cause here; the gate output was explicit and the
  implementer demonstrably understood it (twelve fix-and-retry cycles).
