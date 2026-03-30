---
name: mandate-ui-design
description: Use when evaluating UI designs for consistency, reusability, and themability. Covers semantic tokens, composable components, UI coupling, and separation of styling from event logic. Applicable to both native (Slate) and web (Mantine/React) UI layers.
---

# UI Design Principles

Domain knowledge shared across UI specialist roles, whether working with Slate, Mantine, or other component systems.

## Evaluation Criteria

- **Semantic tokens over magic numbers** — colors, spacing, typography, and sizing should reference named design tokens or theme variables, not hardcoded values.
- **Composable component libraries** — styling and theming layers built on top of headless event logic, not tangled into it.
- **UI consistency, reusability, and themability** — evaluate proposals for their impact on all three.
- **UI coupling** — flag components that embed business logic, styles that leak across boundaries, or widgets that can't be reused outside their original context.
