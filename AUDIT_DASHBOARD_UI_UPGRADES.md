# Dev Audit: Dashboard UI Upgrades

**Scope:** Independent UI/UX improvements to dashboard. No coordination server changes. Can be merged in parallel or independently from server migration.

**Status:** Ready for implementation after Supabase server work completes (or in parallel if team bandwidth allows).

---

## Current Pain Points

### 1. Chat Rooms Lack Deep Linking
- Chat room buttons are not semantic links (no unique URLs)
- Cannot open chat in new tab, share link, or bookmark specific conversation
- No browser history navigation between chats
- **Impact:** Reduces usability for remote monitoring; hard to share specific chat context

### 2. Message Visual Separation Unclear
- Messages blur together; current styling is adequate but not clear
- No individual message containers or visual demarcation
- Sender attribution is ambiguous when reading quickly
- **Impact:** Cognitive load; takes longer to parse who said what

### 3. Scroll Behavior Disrupts Reading
- View jumps when new messages arrive
- User loses reading position when scrolling back through history
- Auto-scroll to latest message breaks manual browsing
- **Impact:** Frustrating UX when monitoring agent progress; forces re-reading

### 4. Messages Page Has No Formatting
- Agents deliver markdown in message payloads
- Rendered as raw text (shows `**bold**`, `##heading`, etc.)
- No syntax highlighting, links, code blocks
- **Impact:** Hard to read structured agent reports; aesthetic regression

---

## Proposed Solutions

### 1. Deep-Linked Chat Routes
**Change:** Introduce URL-based routing for chat rooms.

- **New route:** `/chat/:roomId` (e.g., `/chat/design-team`, `/chat/build-notifications`)
- Chat room list populated from server `GET /messages/channels` endpoint
- Clicking a room navigates to `/chat/:roomId`, which fetches that channel's messages
- Browser history works automatically (back/forward between chats)
- Can open in new tab with `Ctrl+Click`
- Share URL with context: `https://localhost:3000/chat/design-team`

**Implementation:**
- Use TanStack Router (already in place) to add new route
- Chat room list component: `<Link to={`/chat/${room.id}`}>`
- Chat view component: read `roomId` from route params, fetch messages for that channel
- URL sync: when switching chats, update URL; when URL changes, switch chat view

**Risk:** Minimal. Additive change, no breaking changes to existing endpoints.

---

### 2. Message Card Styling (WhatsApp-like)
**Change:** Wrap each message in a visual container with clear demarcation.

- Each message gets a mini-card: background color, border, padding
- Sender name prominently displayed at top of card
- Different background colors for different senders (or alternating)
- Card contains: sender, timestamp, message content, metadata (e.g., "agent-1", "build-success")
- Spacing between cards for visual breathing room

**Implementation:**
- Update `Message` component rendering (or create `MessageCard` wrapper)
- Add Tailwind classes: `border`, `rounded`, `bg-slate-50` (light), `bg-slate-900` (dark)
- Include `<div className="text-sm text-gray-500">{sender} • {timestamp}</div>` above message content
- Use shadcn/ui `Card` component if available, or build custom

**Risk:** Low. Purely visual change, no data/logic changes. May require CSS tweaks for dark/light mode consistency.

---

### 3. Scroll Behavior Fix
**Change:** Prevent auto-scroll-to-bottom when user manually scrolls up.

**Current behavior:** Messages arrive → auto-scroll to latest → user loses position if they were reading history

**Desired behavior:**
- If user is at bottom of chat, auto-scroll to latest (normal operation)
- If user scrolls up to read history, disable auto-scroll until they scroll back to bottom
- Show "New messages" indicator or button to jump to latest

**Implementation:**
- Track scroll position in state: `isAtBottom: boolean`
- On scroll event: calculate if user is within N pixels of bottom
- Only auto-scroll if `isAtBottom === true`
- Show inline "Jump to latest" button if messages arrive while scrolled up
- Use `useEffect` + `useRef` for scroll container tracking

**Risk:** Low. UX improvement, no server changes. Test edge cases (rapid messages, very long history).

---

### 4. Markdown Rendering in Messages
**Change:** Render markdown payloads as formatted text (bold, headings, code blocks, links).

**Candidates:**
- **AI Elements** (`@ai-elements` package) — built-in markdown support, handles code highlighting, mermaid, math
- **react-markdown** + syntax highlighter (lighter weight)
- **Showdown** or **marked** (if no React component needed)

**Recommendation:** Use **AI Elements `<MessageResponse>`** if available (aligns with chat SDK philosophy). Otherwise, `react-markdown` + `highlight.js` for code.

**Implementation:**
- Import markdown renderer
- Update message rendering: `<MarkdownRenderer content={message.content} />`
- Handle edge case: if markdown parsing fails, fall back to raw text with warning

**Risk:** Low. Additive enhancement. Test with real agent markdown to ensure no breakage.

---

### 5. URL-Driven State Management (Broader Consolidation)
**Change:** Encode all UI filters/parameters in URL search params, not just client state.

**Examples:**
- `/chat/:roomId?filter=unread&sort=newest` — filter messages, sort order
- `/messages?channel=design-team&status=pending` — messages page with filters
- `/agents?status=running` — agents page with status filter
- `/builds?target=Game&config=Development` — builds filtered by target/config

**Implementation:**
- Extract URL params in component: `const { searchParams } = useLocation()`
- When user changes filter → update URL: `navigate({ search: `?filter=${newFilter}` })`
- When URL changes → update component state
- Persist across page refresh, shareable (user can bookmark filtered view)

**Risk:** Medium. Requires audit of all pages using filters. Must ensure URL param names are consistent and documented.

---

## Implementation Plan

**Phase 1 (Quick Wins):**
1. Add chat deep-linking (TanStack Router route + channel fetch)
2. Message card styling (CSS + component update)
3. Markdown rendering in messages page

**Phase 2 (UX Polish):**
4. Scroll behavior fix (scroll tracking, "jump to latest" button)
5. URL-driven state management (consolidate all filters into search params)

**Phase 3:**
- Collapsible sidebar navigation (if needed)
- Collapsible chat room list

---

## Database/Server Changes Required

**Minimal.** No server schema changes needed.

**New/Modified Endpoints (already exist):**
- `GET /messages/channels` — list available channels (ensure returns channel names/IDs)
- `GET /messages/:channel` — fetch messages for a specific channel (already works)
- No new database tables or modifications

**Dashboard state:**
- Remove any hard-coded channel filters
- Read from URL params instead of state

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Markdown rendering breaks on unexpected input | Medium | Low (fallback to raw text) | Test with real agent payloads |
| Scroll behavior still jumps in edge cases | Low | Medium (user frustration) | Test rapid message arrivals, long histories |
| URL state not synced correctly | Low | Medium (loss of context) | Test browser back/forward, page refresh |
| Performance regression with many cards | Low | Low (messages table is relatively small) | Monitor render time with 100+ messages |

---

## Testing Checklist

- [ ] Chat room deep links work (`/chat/:roomId` navigates correctly)
- [ ] Browser back/forward navigate between chats
- [ ] Open chat in new tab preserves room ID
- [ ] Share URL with team member, they land on correct chat
- [ ] Message cards render with clear sender/timestamp
- [ ] Dark/light mode applies correctly to card backgrounds
- [ ] Markdown renders correctly (bold, headings, code blocks, links)
- [ ] Markdown fallback works if parsing fails (shows raw text)
- [ ] Scroll behavior: auto-scroll to latest when at bottom
- [ ] Scroll behavior: no auto-scroll when user manually scrolled up
- [ ] "Jump to latest" button appears when scrolled up + new messages arrive
- [ ] URL filters persist on page refresh
- [ ] URL filters work for all filter types (channel, status, sort, etc.)
- [ ] Dashboard smoke test (can load, no console errors)

---

## Success Criteria

- ✅ All deep-linked chat routes work end-to-end
- ✅ Message cards visually distinct with clear sender attribution
- ✅ Markdown renders without breaking layout
- ✅ Scroll behavior smooth; no disruption when reading history
- ✅ All UI state visible in URL (shareable, bookmarkable)
- ✅ No server changes required; no new database tables
- ✅ Dashboard loads without performance regression

---

## Notes for Review

- **Independent of server migration:** Can be merged now, after, or in parallel with Supabase work
- **No breaking changes:** All changes additive; existing functionality preserved
- **Quick ROI:** Scroll fix + markdown rendering have high perceived impact for minimal effort
- **Deferred:** Collapsible sidebar, chat room list collapse — nice-to-have, lower priority than above

