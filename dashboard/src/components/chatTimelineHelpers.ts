/**
 * Pure helpers for ChatTimeline.
 *
 * Extracted into a separate module so the component file (which exports a
 * React component) does not also export non-component values, which would
 * trip `react-refresh/only-export-components`. Tests live next to this file.
 */

/**
 * Build the catch-up button label. Surfaces the unread count when at least
 * one message is unread; otherwise reads as a plain "Jump to latest" call to
 * action.
 */
export function buildJumpToLatestLabel(unreadCount: number): string {
  return unreadCount > 0 ? `Jump to latest (${unreadCount})` : 'Jump to latest';
}

/**
 * Whether the catch-up `Transition` should be mounted. The button is mounted
 * when the auto-scroll hook itself raises `showJumpToLatest`, OR when the
 * global auto-scroll toggle is off and there is at least one unread message.
 *
 * The second branch is what makes the button surface unread state when the
 * operator has paused auto-scroll: the hook's own indicator depends on the
 * viewport scroll position, while the unread-count branch depends on the
 * preference toggle.
 */
export function shouldMountJumpToLatest(
  showJumpToLatest: boolean,
  autoScrollEnabled: boolean,
  unreadCount: number,
): boolean {
  return showJumpToLatest || (!autoScrollEnabled && unreadCount > 0);
}

/**
 * Decide whether the trailing-message effect should mark the room read.
 *
 * The component already checks "is there a new trailing message" before
 * calling this — that check lives inside the `useEffect` because it depends
 * on a ref. Once the new-message check has passed, this helper answers the
 * question "given the current preference, do we keep unread at zero or let
 * it accumulate?". It is true exactly when the global auto-scroll toggle is
 * on; that matches the spec's worked example, where unread count stays at 0
 * while auto-scroll is on and accumulates while auto-scroll is off.
 */
export function shouldMarkReadOnNewMessage(autoScrollEnabled: boolean): boolean {
  return autoScrollEnabled;
}

/**
 * Decide whether the auto-scroll-toggle transition should mark the room
 * read. True only on a false → true transition. Equal-to-equal calls and
 * true → false transitions both return false.
 *
 * Pairs with the `useAutoScroll` hook's own false → true behaviour (scroll
 * to sentinel + clear `showJumpToLatest`).
 */
export function shouldMarkReadOnAutoScrollTransition(
  prevEnabled: boolean,
  nextEnabled: boolean,
): boolean {
  return !prevEnabled && nextEnabled;
}
