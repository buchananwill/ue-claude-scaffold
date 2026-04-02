---
title: Every message board post appears twice
priority: medium
reported-by: will
date: 2026-04-02
---

# Duplicate Message Board Posts

Every message posted to the coordination server's message board appears as two identical entries with sequential IDs.
This was observed across multiple container runs and affects all message types (`status_update`, `phase_start`,
`progress`, etc.).

## Evidence

```
#57 [status_update] {"content": "[STYLE REVIEW] Phase 1 ..."}
#58 [status_update] {"content": "[STYLE REVIEW] Phase 1 ..."}
#59 [status_update] {"content": "[SAFETY REVIEW] Phase 1 ..."}
#60 [status_update] {"content": "[SAFETY REVIEW] Phase 1 ..."}
```

The entrypoint smoke test also duplicates:
```
#46 [status_update] {"message": "Container online. Preparing to launch Claude agent."}
#63 [status_update] {"message": "Container online. Preparing to launch Claude agent."}
```

## Possible Causes

- A hook (PreToolUse or PostToolUse) re-executing the curl command
- The entrypoint's `tee` pipeline causing a double-write
- A server-side bug inserting twice per request
- The agent's own curl command being intercepted and replayed by a hook
