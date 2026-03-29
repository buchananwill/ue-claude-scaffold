---
name: review-output-schema
description: Use when a review agent must produce structured output. Defines the BLOCKING/WARNING/Summary/Verdict template and scoring rubric. Compose with review-process and a domain skill.
---

# Review Output Schema

Standard output format for all code reviewers. Domain-specific sections can be added between "Files Reviewed" and "BLOCKING".

## Template

```
# <Domain> Review: <brief description>

## Files Reviewed
- `<path>` (N lines)

## BLOCKING

### [B1] <Title> — `<file>:<line>` (confidence: <90-100>)
**Category**: <domain-specific category>
**Description**: <what's wrong>
**Evidence**: <the specific code path or rule reference>
**Fix**: <specific correction>

## WARNING

### [W1] <Title> — `<file>:<line>` (confidence: <75-89>)
**Category**: <category>
**Description**: <what's concerning>
**Evidence**: <code path or rule reference>
**Fix**: <recommendation>

## Summary
- BLOCKING: N issues
- WARNING: N issues
- Verdict: **APPROVE** / **REQUEST CHANGES**
```

## Rules

- Every finding must include `file:line` and a rule or evidence reference.
- Use sequential IDs: B1, B2... for BLOCKING; W1, W2... for WARNING.
- Verdict is REQUEST CHANGES if any BLOCKING or WARNING exists.
- Some domains add a NOTE tier (confidence 50-74, informational only). If present, NOTEs do not affect the verdict.
