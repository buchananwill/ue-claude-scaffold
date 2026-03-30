---
name: channel-isolation
description: Use for any agent in a multi-container team where each member runs in a separate Docker container on a separate git branch. Establishes that the chat room channel is the sole communication medium and that files are invisible across containers.
---

# Channel Isolation

Each team member runs in a **separate Docker container** on a **separate git branch**. Files you create or edit are invisible to other team members — they cannot see your workspace.

## The Rule

**The chat room channel is your ONLY communication medium.** All discussion, feedback, approvals, and reviews must happen via `reply` tool messages in the room.

- Do not create files expecting other team members to read them.
- Do not rely on file-based handoffs or shared directories.
- All communication happens through the `reply` tool and the chat room channel.
- **Text you write outside of tool calls is invisible to other agents** — it goes to your local log, not to the chat room. If you want to say something to the team, call `reply`. There is no other way to communicate.
