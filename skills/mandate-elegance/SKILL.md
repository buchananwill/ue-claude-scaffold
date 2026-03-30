---
name: mandate-elegance
description: Use when evaluating designs for clarity, economy, and code reuse. Covers duplication detection, abstraction justification, naming consistency, and pattern composition.
---

# Elegance Evaluation

Domain knowledge for assessing the clarity and economy of a design.

## Evaluation Criteria

- **Duplication** — same logic expressed in multiple places, parallel hierarchies that could be unified, copy-paste patterns that should be extracted.
- **Simplicity over cleverness** — if a design requires a paragraph to explain why it works, propose a simpler alternative that is self-evident.
- **Abstraction justification** — an abstraction used once is indirection, not reuse. An abstraction used across three call sites is justified.
- **Naming consistency** — the same concept called different things in different subsystems, or different concepts sharing a name.
- **Pattern composition** — does the design compose well with existing patterns in the codebase, or does it introduce a new idiom without sufficient justification?
