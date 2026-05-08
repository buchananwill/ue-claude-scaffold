/**
 * Tests for ChatTimeline pure helpers.
 *
 * The component itself uses React hooks, so its logic-bearing branches were
 * extracted into pure helpers in `chatTimelineHelpers.ts`. These tests cover
 * the conditional branches the component renders on:
 *   - the unread-count label switch
 *   - the `mounted` OR-clause for the catch-up Transition
 */

import { describe, it, expect } from 'vitest';
import {
  buildJumpToLatestLabel,
  shouldMarkReadOnAutoScrollTransition,
  shouldMarkReadOnNewMessage,
  shouldMountJumpToLatest,
} from './chatTimelineHelpers.ts';

describe('buildJumpToLatestLabel', () => {
  it('returns the plain label when there are no unread messages', () => {
    expect(buildJumpToLatestLabel(0)).toBe('Jump to latest');
  });

  it('appends the count in parentheses for one unread message', () => {
    expect(buildJumpToLatestLabel(1)).toBe('Jump to latest (1)');
  });

  it('appends the count for many unread messages', () => {
    expect(buildJumpToLatestLabel(42)).toBe('Jump to latest (42)');
  });

  it('returns the plain label for a negative count (defensive)', () => {
    // The component is responsible for never producing negative unreadCount,
    // but the helper guards the boundary cleanly.
    expect(buildJumpToLatestLabel(-1)).toBe('Jump to latest');
  });
});

describe('shouldMountJumpToLatest', () => {
  it('mounts when the hook itself raises showJumpToLatest (auto-scroll on, no unread)', () => {
    expect(shouldMountJumpToLatest(true, true, 0)).toBe(true);
  });

  it('mounts when the hook raises showJumpToLatest (auto-scroll off, no unread)', () => {
    expect(shouldMountJumpToLatest(true, false, 0)).toBe(true);
  });

  it('does not mount when auto-scroll is on and no unread, even with no hook signal', () => {
    expect(shouldMountJumpToLatest(false, true, 0)).toBe(false);
  });

  it('does not mount when auto-scroll is on with unread (auto-scroll clears unread)', () => {
    // Real component should never reach unreadCount > 0 while autoScrollEnabled
    // is true (the lastMessageId effect calls onMarkRead under autoScroll).
    // The helper still returns false because the OR-clause is gated on
    // !autoScrollEnabled.
    expect(shouldMountJumpToLatest(false, true, 5)).toBe(false);
  });

  it('mounts when auto-scroll is off and at least one message is unread', () => {
    expect(shouldMountJumpToLatest(false, false, 1)).toBe(true);
  });

  it('mounts on the unread branch when there are many unread', () => {
    expect(shouldMountJumpToLatest(false, false, 99)).toBe(true);
  });

  it('does not mount when auto-scroll is off but unread is zero and no hook signal', () => {
    expect(shouldMountJumpToLatest(false, false, 0)).toBe(false);
  });
});

describe('shouldMarkReadOnNewMessage', () => {
  it('marks read when auto-scroll is enabled (clamps unread to zero)', () => {
    expect(shouldMarkReadOnNewMessage(true)).toBe(true);
  });

  it('does not mark read when auto-scroll is disabled (lets unread accumulate)', () => {
    expect(shouldMarkReadOnNewMessage(false)).toBe(false);
  });
});

describe('shouldMarkReadOnAutoScrollTransition', () => {
  it('marks read on a false → true transition', () => {
    expect(shouldMarkReadOnAutoScrollTransition(false, true)).toBe(true);
  });

  it('does not mark read on a true → false transition', () => {
    expect(shouldMarkReadOnAutoScrollTransition(true, false)).toBe(false);
  });

  it('does not mark read on a steady-state true (no transition)', () => {
    expect(shouldMarkReadOnAutoScrollTransition(true, true)).toBe(false);
  });

  it('does not mark read on a steady-state false (no transition)', () => {
    expect(shouldMarkReadOnAutoScrollTransition(false, false)).toBe(false);
  });
});
