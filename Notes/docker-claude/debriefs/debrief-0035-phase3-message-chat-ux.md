# Debrief 0035 -- Phase 3: Message and Chat UX

## Task Summary

Implement Phase 3 of the dashboard multi-tenancy UI plan covering three sub-features:
1. **3.1 Message Card Styling** -- Replace flat message rendering with Mantine Paper cards, colour-coded by agent name
2. **3.2 Markdown Rendering** -- Add react-markdown with syntax highlighting for message payloads
3. **3.3 Scroll Behaviour Fix** -- Track scroll position, only auto-scroll when at bottom, show "Jump to latest" button

## Changes Made

- **`dashboard/package.json`** -- Added `react-markdown`, `react-syntax-highlighter`, `@types/react-syntax-highlighter` dependencies
- **`dashboard/src/utils/agentColor.ts`** (created) -- Utility that hashes agent names to consistent Mantine colour strings from a palette of 12 colours
- **`dashboard/src/components/MarkdownContent.tsx`** (created) -- Shared markdown renderer using react-markdown + react-syntax-highlighter (Prism/oneDark theme); falls back to raw text on parse failure
- **`dashboard/src/hooks/useAutoScroll.ts`** (created) -- Reusable hook that tracks isAtBottom state via scroll events, exposes showJumpToLatest/jumpToLatest/onNewContent for both MessagesFeed and ChatTimeline
- **`dashboard/src/components/MessagesFeed.tsx`** (modified) -- Replaced flat Box message rendering with Paper cards with coloured left border per agent; string/message payloads now rendered through MarkdownContent; integrated useAutoScroll hook replacing the old always-scroll-to-bottom logic; added "Jump to latest" floating button via Mantine Transition
- **`dashboard/src/components/ChatTimeline.tsx`** (modified) -- Same card styling treatment (Paper with coloured left border); message content rendered through MarkdownContent; integrated useAutoScroll hook; added "Jump to latest" button

## Design Decisions

- **Agent colour hashing**: Used a simple `hash * 31 + charCode` algorithm over a 12-colour Mantine palette. Deterministic and collision-resistant enough for typical agent counts (2-8).
- **Markdown detection for MessagesFeed**: Messages with `payload.message` (string) or string payloads get markdown rendering. Object payloads without a `.message` field still render as JSON code blocks, preserving existing behaviour for structured data.
- **useAutoScroll as a shared hook**: Both MessagesFeed and ChatTimeline needed the same scroll-tracking logic. Extracted to a hook with a ref-callback pattern for the viewport element to attach scroll listeners.
- **80px bottom threshold**: Considered "at bottom" if within 80px of the scroll bottom, which accommodates slight rendering differences.
- **Mantine Transition**: Used Mantine's built-in Transition component with slide-up animation for the "Jump to latest" button, keeping it consistent with the design system.

## Build & Test Results

- TypeScript type-check (`npx tsc -b --noEmit`): PASS -- clean, no errors
- No unit tests to run for dashboard components (no existing test infrastructure for React components in this project)

## Open Questions / Risks

- The react-syntax-highlighter bundle is relatively large; if bundle size becomes a concern, could switch to a lighter alternative like rehype-highlight
- The `oneDark` Prism theme was chosen for dark-mode aesthetics; if the dashboard supports light mode, a theme-aware selection might be needed

## Suggested Follow-ups

- Add keyboard shortcut (e.g., End key) to jump to latest in message views
- Consider virtualized rendering for very long message lists (hundreds of messages)
- Theme-aware syntax highlighting (light/dark mode detection)
