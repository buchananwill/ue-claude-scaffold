---
title: "Dashboard chat room view needs an auto-scroll toggle"
priority: medium
reported-by: interactive-session
date: 2026-04-29
status: open
---

# Dashboard chat room view needs an auto-scroll toggle

## Required behaviour

The dashboard's chat room transcript view must offer a control to switch off automatic scroll-to-newest-message when new messages arrive. While auto-scroll is off, the visible message in the viewport must stay anchored as new messages append below — the operator must be able to read a message at their own pace without the view jumping.

The control's state must be obvious from the UI (e.g. a toggle button or paused-scroll indicator). When new messages have been appended below the visible range while auto-scroll is off, that fact must also be visible — typically as an unread-count badge or a "new messages below" affordance — so the operator can choose to jump to the bottom when ready.

Default state when first opening a room is auto-scroll on. The operator's preference within a room may persist for the room's lifetime in that browser session; cross-room and cross-session persistence is optional.

## Why this is needed

When a multi-agent design team is in active discussion, the room receives new messages at a rate of multiple per minute. With auto-scroll always on, any attempt to read a longer message — or to scroll back to compare two earlier statements — is interrupted by the view snapping to the latest message. Following the conversation in real time becomes impossible.

The operator's role in a design team is to participate when needed, which requires reading messages at human pace. The current behaviour effectively forces them to wait until the discussion concludes (or pause it) before they can read it.
