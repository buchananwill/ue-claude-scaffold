---
name: cleanup-session-protocol
description: Use for the cleanup session leader. Defines the issue surfacing, fix cycle, review round, clean-check voting, and cleanup report phases unique to cleanup sessions.
---

# Cleanup Session Protocol

Protocol for the active phases of a code cleanup session. The leader is the **only editor** — team members are advisors who read, critique, and surface issues.

## Issue Surfacing

Open the floor: post a short summary of the cleanup scope (3-5 sentences), then ask specific members to review specific areas using `@agent-name`.

Team members respond with issues — style violations, dead code, unclear naming, missing error handling, unnecessary complexity. Each issue should be a short, actionable message with file path and line number.

**Your role during surfacing:**
- Direct traffic. Ask specific members to look at specific files or subsystems.
- Acknowledge each issue briefly: "Got it" or "Will fix" or "Disagree — [reason]."
- If you disagree with an issue, say why in 1-2 sentences. The team can push back.
- Batch issues mentally. Do not start fixing mid-surfacing.
- When the flow of new issues slows, announce: "Closing this surfacing round. Fixing now."

## Fix Cycle

Work through the surfaced issues. For each fix:

1. Edit the file(s).
2. Run the build script. The build intercept hook will commit, push, and build automatically.
3. If the build fails, fix the error and rebuild. Do not move on until the build is green.
4. After a successful build, post to the channel: "Fixed [brief description]. Build green. Fetch my branch to review."

**Batch small related fixes together** — don't trigger a build for every single-line change. Group fixes by file or by theme, then build once.

## Review Round

After completing all fixes from the current surfacing round:

1. Post: "All fixes from this round are pushed. Fetch and review with:"
2. Post the exact commands (substitute your actual agent name):
   ```
   git fetch origin docker/{your-agent-name}
   git diff HEAD FETCH_HEAD
   ```
3. Wait for participants to review and respond.

## Clean-Check Vote

**If new issues are surfaced:** return to Fix Cycle.

**If no new issues:** initiate a clean-check vote.

Post: "No new issues raised. Vote: is the code clean? Reply **Clean** or **Not clean** (with specifics)."

- Wait for ALL members to vote. Do not tally early.
- If unanimous **Clean** or strict majority **Clean**: proceed to conclusion.
- If **Not clean** wins: address the specifics raised, return to Fix Cycle.

**Maximum 5 full loops** (surfacing -> fix -> review). If the code is not clean after 5 loops, record remaining issues and conclude.

## Cleanup Report

Write a cleanup report to `plans/cleanup-report-{brief-name}.md` on disk. Include:

- Files modified
- Issues fixed (one-liner each)
- Issues deferred (if any, with reasons)
- Final build status

## Scope Constraints

- You are the sole editor. Team members advise and review only.
- Stay within the scope defined by the brief. Do not refactor adjacent systems unless the brief authorizes it.
- Do not add new features. Cleanup means: fix style, remove dead code, improve naming, simplify logic, fix obvious bugs.
- If you discover a real bug that needs a design decision, defer it.
