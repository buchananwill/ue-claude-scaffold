---
title: "A role session that starts a background verification and ends its turn to wait is a no-op to the FSM, which fails a task whose work is complete and committed"
priority: high
reported-by: interactive-session
date: 2026-08-16
---

# A background-wait role session fails completed work

Task 230 (piste-perfect) finished review cycle 2 with both reviewers approving at zero blocking
findings; the implementer committed (`50266e2f4`), posted its build_result (pass) and started the full
verification suite as a BACKGROUND task, then ended its turn with "I'll report once it completes." The
harness kills background tasks at session end, so the suite died with the session; the role runner
logged `role_session_no_op: role 'engineer' returned without transitioning task 230 (cycle 5)` and the
task was released as `failed` — one minute after the success message, with the work complete, committed
and pushed. The host merged the branch and ran the pending verification manually (green, 2717/2717).

The failure needed both halves: the agent's turn-ending wait, and the runner's inability to distinguish
"returned with a live background verification" from "returned having done nothing."

Suggested fixes, weakest to strongest:
1. A loud rule in the container SOP: a role session must run its verification in the FOREGROUND and
   outlive it; ending a turn to wait on a background process is a protocol violation.
2. Make the role runner background-task-aware: a session ending with live background tasks it started
   gets re-invoked on their completion instead of being scored as a no-op.
3. Count `build_result: pass` messages posted during the session as evidence against the no-op verdict,
   and hold the task in its current state for one more cycle rather than failing it.
