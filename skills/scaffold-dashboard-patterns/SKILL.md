---
name: scaffold-dashboard-patterns
description: React, Mantine UI, TanStack Router, and TanStack Query conventions for any dashboard SPA on this stack.
axis: domain
---

# Dashboard Patterns

Domain knowledge for React SPA codebases built on Vite + Mantine + TanStack Router + TanStack Query. Project-specific details (API base URL, auth headers, route layout, domain entities) come from the project's own code — not from this skill.

## Tech Stack

- **React** — UI library
- **Vite** — build tool and dev server
- **Mantine** — component library and theme system
- **TanStack Router** — file-based routing with type-safe route params
- **TanStack Query** — server state management (polling, cache invalidation, mutation coherence)

## Mantine Conventions

- Use Mantine components over raw HTML elements (`Button`, `TextInput`, `Stack`, `Group`, `Paper`, etc.)
- Use Mantine theme tokens for spacing, colors, and typography — not magic CSS values:

```tsx
// CORRECT — theme tokens
<Box p="md" bg="gray.1" fz="sm">

// WRONG — magic values
<Box style={{ padding: 16, backgroundColor: '#f1f3f5', fontSize: 14 }}>
```

- Use `@mantine/hooks` for common UI patterns (useDisclosure, useMediaQuery, useDebouncedValue)

## TanStack Query

- Server state fetched via `useQuery`; polling intervals are appropriate when the server does not push updates
- The API base URL and auth headers are project-specific — read them from the project's own client wrapper, do not hardcode
- Query keys are descriptive arrays whose first element names the resource and later elements carry disambiguating parameters, e.g. `[resource]`, `[resource, id]`, `[resource, { filter }]`. Always include any tenant / project scoping parameter that affects the response.
- Mutations use `useMutation` with appropriate `onSuccess` invalidation

## TanStack Router

- File-based routing using TanStack Router's generated tree — follow whatever routes directory the project already established
- Route params and search params are type-safe; prefer the generated route types over hand-rolled `any`
- Shared chrome (navigation, page frames) belongs in layout routes, not copy-pasted into leaf routes

## Component Composition

- Prefer composable components: headless logic hook + styled wrapper
- Keep components focused — one responsibility per component
- Extract reusable patterns into shared components rather than duplicating JSX
