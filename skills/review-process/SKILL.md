---
name: review-process
description: Use when an agent must review code changes. Defines the universal review sequence — identify files, read context, check against domain criteria, score, filter. Compose with a domain skill and review-output-schema.
---

# Review Process

Base review protocol for all code reviewers. Every review follows this sequence.

## Steps

### Step 1: Identify Changed Files

- If given a git range: `git diff <range> --name-only` filtered to relevant extensions
- If given file paths: use those directly
- If given a feature description: search for recently modified files

### Step 2: Read Full Context

For each changed file:
1. Read the **complete file** — not just the diff
2. Read any **project headers** it includes (not engine/framework headers) — you need to see the types being used
3. If a changed function takes or returns a pointer/reference, `Grep` for that symbol to understand its lifecycle across call sites

Adapt depth to your mandate: style review may be self-contained per file; safety and correctness review require cross-file tracing.

### Step 3: Check Against Domain Criteria

Systematically check every rule from your loaded domain skill(s). For each file, for each rule category — be thorough but precise. Only flag things that are clearly violations, not judgment calls.

### Step 4: Score and Filter

Rate every potential finding on a confidence scale. Apply the scoring thresholds and output format from your output schema. Only report issues you can substantiate with specific code evidence.
