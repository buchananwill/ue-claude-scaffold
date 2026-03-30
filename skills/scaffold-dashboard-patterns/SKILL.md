---
name: scaffold-dashboard-patterns
description: React, Mantine UI, TanStack Router, and TanStack Query conventions for the ue-claude-scaffold monitoring dashboard.
axis: domain
---

# Scaffold Dashboard Patterns

Domain knowledge for the dashboard SPA in `dashboard/`.

## Tech Stack

- **React** — UI library
- **Vite** — build tool and dev server
- **Mantine** — component library and theme system
- **TanStack Router** — file-based routing with type-safe route params
- **TanStack Query** — server state management (polling the coordination server)

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

- Server state fetched via `useQuery` with polling intervals for real-time updates
- The coordination server base URL is configurable (default `http://localhost:9100`)
- Query keys should be descriptive arrays: `['agents']`, `['messages', channel]`, `['tasks', { status }]`
- Mutations use `useMutation` with appropriate `onSuccess` invalidation

## TanStack Router

- File-based routing in `src/routes/`
- Route params and search params are type-safe
- Layouts share common UI (navigation, status bar)

## Component Composition

- Prefer composable components: headless logic hook + styled wrapper
- Keep components focused — one responsibility per component
- Extract reusable patterns into shared components rather than duplicating JSX
