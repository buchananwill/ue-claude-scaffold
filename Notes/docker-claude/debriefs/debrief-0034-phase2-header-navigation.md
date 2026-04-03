# Debrief 0034 -- Phase 2: Header and Navigation

## Task Summary

Implement Phase 2 of the dashboard multi-tenancy UI plan: display the active project name from `useProject()` context in the HealthBar header, and make it a link back to the project picker root (`/`).

## Changes Made

- **dashboard/src/components/HealthBar.tsx** -- Modified to import and use `useProject()` for the project name instead of reading it from the `/health` endpoint config. The project name is now wrapped in a Mantine `Anchor` component linked to `/` (the project picker/root route), allowing users to switch projects by clicking the header title.

## Design Decisions

- Used `useProject()` directly in HealthBar rather than threading it as a prop from DashboardLayout, per the requirements. This is safe because HealthBar is always rendered inside DashboardLayout which is inside ProjectProvider.
- Used Mantine's `Anchor` component with `component={Link}` to leverage TanStack Router's client-side navigation rather than a full page reload.
- Set `underline="never"` and `c="inherit"` on the anchor to keep the visual appearance consistent with the previous bold text styling while still being clickable.
- The link target is `/` (absolute root), which goes to the RootLayout project picker. For single-project setups this auto-redirects back; for multi-project setups it shows the project selection grid.

## Build & Test Results

- `npx tsc -b --noEmit` passed cleanly with no errors.

## Open Questions / Risks

- None identified. The change is minimal and well-scoped.

## Suggested Follow-ups

- If desired, a dropdown could replace the simple link for inline project switching without navigating away from the current page context.
