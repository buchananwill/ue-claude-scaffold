---
name: commit-discipline
description: Use for any agent with write access inside a Docker container. Defines when and how to commit work. Commits are automatically pushed to the bare repo — the agent only needs to run git commit.
---

***ACCESS SCOPE: write-access***

# Commit Discipline

Your commits are the only work that survives the container. Everything uncommitted is lost when the container stops. The system automatically pushes every commit to the bare repo — you never need to run `git push`.

## When to Commit

Commit after each completed **work unit**:

- After completing a plan phase
- After completing a logical sub-section of a large phase
- After any change that leaves the codebase in a buildable/testable state

If a phase is large, break it into smaller commits proactively. Do not accumulate a large batch of uncommitted changes.

## Commit Messages

Write descriptive commit messages that explain what was done and why:

```
Add connection pooling to database adapter

Introduces pg.Pool with configurable max connections, idle timeout,
and connection timeout. Health endpoint now reports pool metrics.
```

Do not use generic messages like "WIP" or "changes". Each commit should be understandable in isolation.

## What Not to Do

- Do not run `git push` — the system handles this automatically after every commit
- Do not create new branches — you are assigned to one branch and must stay on it
- Do not amend previous commits — create new commits instead
- Do not accumulate large uncommitted changesets across multiple work units
