---
title: "An engineering-state task whose claimant container is stopped can be neither released nor reset"
priority: medium
reported-by: interactive-session
date: 2026-08-16
---

# A mid-state task with a stopped claimant is administratively stuck

During the task-228 stale-seed recovery (see issue 067), the claiming container was stopped while the
task sat in `engineering`. Every administrative exit was refused: `POST /tasks/:id/reset` ("task can
only be reset when complete, failed, or cycle"), `POST /tasks/:id/release` ("FSM mid-state ... stays
attached to the claiming agent"), `DELETE` ("release it first"). The only recovery was relaunching a
container under the same agent name so the attached task resumed with it — which worked, but is
undocumented, and depends on the operator guessing that re-attachment is the intended path.

Related: issue 064 records the adjacent case (agent death). This one is specifically the
operator-initiated stop, where the operator has full context and still has no sanctioned lever.

Suggested fixes:
1. Allow release when the claiming agent's container is verifiably not running (the server already
   tracks agent status).
2. Or document re-attachment-by-relaunch as the sanctioned recovery in the launch script's own help.
