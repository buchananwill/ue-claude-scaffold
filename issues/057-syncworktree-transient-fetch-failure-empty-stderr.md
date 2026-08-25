---
title: "syncWorktree git fetch fails transiently with empty stderr; error is undiagnosable and unretried"
priority: medium
reported-by: interactive-session
date: 2026-07-10
---

# What happened

Task 194 (piste-perfect, agent-1, revision cycle 1): the implementer committed and pushed
`3a038965c` at 14:58:32Z, then every `python3 Scripts/build.py` attempt from 14:58:35Z to
~15:00Z (6 attempts) failed pre-build with:

```
Infrastructure error: syncWorktree: git fetch failed: . Agent should shut down.
```

Note the empty stderr after `failed:`. The push had already landed — `3a038965c` is the tip
of `docker/piste-perfect/agent-1` in the bare repo — and the identical fetch
(`git fetch D:/Coding/resort_game/docker-claude/repo.git docker/piste-perfect/agent-1` in
`D:\Coding\resort_game\staging\agent-1`) succeeds when run manually ~1h later. The failure
was transient, lasting roughly two minutes immediately after the container's push through
the bind mount.

Consequences: no build was ever attempted (no row in `/builds`), the engineer session ended
without posting a transition, and the pump failed the task with `role_session_no_op` even
though the code fixes were complete and pushed.

# Diagnostic gap

`runCommand` in `server/src/routes/build.ts` distinguishes three failure paths:

- spawn error → stderr = `err.message` (e.g. the known May-era `spawn git ENOENT`),
- timeout → stderr gets a `[killed: ...]` suffix,
- non-zero exit → stderr = whatever git printed.

Empty stderr therefore means git **exited non-zero printing nothing**, which normal git
never does (fatal errors always print). Candidates: git.exe crashing (access-violation exit
codes produce no stderr — plausibly from reading pack files mid-write through the Docker
bind mount right after the container's push), or the child being killed externally. No
Windows Application-log crash event was recorded, so this is unconfirmed — and that is the
point: the error response discards `exit_code` and `output` (stdout), so the one datum that
would distinguish a crash (e.g. exit code 3221225477) from anything else is lost.

# Requests

1. **Include the exit code and stdout in the syncWorktree error message**, e.g.
   `git fetch failed (exit <code>): <stderr || stdout || "(no output)">`. Empty-string
   interpolation should never be possible.
2. **Retry the sync once or twice with a short backoff** before returning the fatal
   "Agent should shut down" response. The failure window here was seconds long, immediately
   after a container push to the bare repo — exactly the moment a transient
   bind-mount/object-visibility race is most likely. A single 2–5 s retry would very likely
   have saved the whole review cycle.
3. Consider logging the full SpawnResult of failed sync commands server-side so post-hoc
   diagnosis does not depend on what the container relayed.
