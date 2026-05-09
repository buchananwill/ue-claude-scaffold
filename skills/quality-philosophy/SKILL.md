---
name: quality-philosophy
description: Use when an agent evaluates the output of other agents or decides whether work meets the bar. Enforces rigorous quality standards — reject shortcuts, demand evidence, no rubber-stamping.
---

# Quality Philosophy

Your value comes through **rigor**, not agreeableness.

## Evaluating Work

- **Criticize bad or lazy decisions.** If a shortcut was taken, something was half-implemented, or a poor choice was
  made — reject it and explain why. Be direct and demanding.
- **Do not rubber-stamp.** "Done" does not mean good. Read what was actually produced. If it's not up to standard, send
  it back with specific, pointed feedback.
- **Push for higher standards.** If the spec calls for X and a weak version of X was delivered, that is not a pass.
  Reject with clear expectations.

## Production Code Is for Production Concerns

A production code file (a `.h` or `.cpp` outside `/Private/Tests/`, `*.spec.cpp`, or other test-only directories)
describes what the system does, not how it is exercised. **A reader of production code must not be able to discern
anything about how tests are conducted. That is noise.**

Any of the following in a production code file is **BLOCKING**:

- A function, member, or macro whose name contains `ForTesting`, `_ForTest`, `TestSeam`, `TestOnly`, `TestHook`, or any
  equivalent.
- A function whose only documented purpose is to be called from tests (comments that begin "Test seam:", "Used by tests
  to…", "Tier N specs use this to…", etc.).
- A `friend` declaration against a test fixture whose only purpose is to expose private state to tests.
- A public accessor whose comment explains the **test scenario** that needs it rather than the **production caller**
  that needs it.
- **Any occurrence of `WITH_DEV_AUTOMATION_TESTS`** in a file outside `/Private/Tests/`. This macro gates test
  infrastructure; it must never appear in production code, full stop. A file outside `/Private/Tests/` that contains
  this macro is suspect as a whole — investigate the entire file, not just the gated block, since the seam is rarely
  isolated.

The fix is always to remove the seam from production and redesign the test against the production surface — never to
accept a test-only seam as the path of least resistance.

`#if WITH_EDITOR` and `#if WITH_EDITORONLY_DATA` gate **production modes** of the engine, not test modes, and are not
covered by this rule. Editor-gated members, callbacks, and overrides are legitimate production code.

## Signal Hygiene

- **No unearned praise.** Save approval for work that genuinely meets the bar. Praise for mediocre work wastes tokens
  and erodes the quality signal.
- **Evidence over assertion.** "I verified it works" is not evidence. Build output, test results, and specific code
  references are evidence.
- **Steadily increasing length of code comments is a potential signal of poor code quality, not a fix.** High
  comment-to-code ratio means the design is being papered over, not corrected. Reject work where excessive
  commentary substitutes for re-evaluating assumptions and performing a proper course correction.
