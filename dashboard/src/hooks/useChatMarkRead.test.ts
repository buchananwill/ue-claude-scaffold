/**
 * Tests for useChatMarkRead.
 *
 * The hook's responsibility is the *coordination* of three trigger effects
 * plus a memoised callback. Following the codebase pattern (see
 * `useAutoScrollPreference.test.ts` and `useTaskFilters.test.ts`) we
 * replicate the effect sequencing as a pure state machine so the logic can
 * be exercised without a React renderer or a DOM. The hook itself wires the
 * same predicates into useEffect / useLayoutEffect / useCallback.
 *
 * The pure predicates (`shouldMarkReadOnNewMessage`,
 * `shouldMarkReadOnAutoScrollTransition`) live in chatTimelineHelpers.ts and
 * are already covered by their own tests. These tests cover the
 * *sequencing* the hook layers on top of those predicates — when the
 * room-switch effect fires, when the new-message effect fires once per
 * fresh trailing id, when the transition effect fires (and only on a
 * false → true edge), and the handleJumpToLatest call order.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldMarkReadOnAutoScrollTransition,
  shouldMarkReadOnNewMessage,
} from '../components/chatTimelineHelpers.ts';

// ---------------------------------------------------------------------------
// Pure replicas of the hook's effect bodies. The hook stores these values in
// refs / closures; here we make them explicit so the sequencing is testable.
// ---------------------------------------------------------------------------

interface MarkReadCoordinator {
  // Latest onMarkRead identity (mirrored via ref in the hook).
  onMarkReadRef: { current: () => void };
  // Previously-rendered autoScrollEnabled (used by the transition effect).
  prevAutoScrollEnabled: boolean;
  // Previously-acted-on lastMessageId (used by the new-message effect).
  lastSeenId: string | number | null;
}

function createCoordinator(initialEnabled: boolean, initialOnMarkRead: () => void): MarkReadCoordinator {
  return {
    onMarkReadRef: { current: initialOnMarkRead },
    prevAutoScrollEnabled: initialEnabled,
    lastSeenId: null,
  };
}

// Body of the `[roomId]` effect. Fires onMount and on every roomId change.
function runRoomSwitchEffect(c: MarkReadCoordinator) {
  c.onMarkReadRef.current();
}

// Body of the `[lastMessageId, autoScrollEnabled, onNewContent]` effect.
function runNewMessageEffect(
  c: MarkReadCoordinator,
  lastMessageId: string | number | null,
  autoScrollEnabled: boolean,
  onNewContent: () => void,
) {
  if (lastMessageId !== null && lastMessageId !== c.lastSeenId) {
    c.lastSeenId = lastMessageId;
    onNewContent();
    if (shouldMarkReadOnNewMessage(autoScrollEnabled)) {
      c.onMarkReadRef.current();
    }
  }
}

// Body of the `[autoScrollEnabled]` transition effect.
function runAutoScrollTransitionEffect(c: MarkReadCoordinator, autoScrollEnabled: boolean) {
  if (shouldMarkReadOnAutoScrollTransition(c.prevAutoScrollEnabled, autoScrollEnabled)) {
    c.onMarkReadRef.current();
  }
  c.prevAutoScrollEnabled = autoScrollEnabled;
}

// Body of handleJumpToLatest. Calls jumpToLatest, then the latest onMarkRead.
function runHandleJumpToLatest(c: MarkReadCoordinator, jumpToLatest: () => void) {
  jumpToLatest();
  c.onMarkReadRef.current();
}

// useLayoutEffect-equivalent: refresh the onMarkRead mirror.
function refreshOnMarkRead(c: MarkReadCoordinator, onMarkRead: () => void) {
  c.onMarkReadRef.current = onMarkRead;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatMarkRead — room-switch effect', () => {
  it('calls onMarkRead on initial mount', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const c = createCoordinator(true, onMarkRead);
    runRoomSwitchEffect(c);
    expect(calls).toEqual(['mark']);
  });

  it('calls onMarkRead again when roomId changes (effect re-runs)', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const c = createCoordinator(true, onMarkRead);
    // Mount with roomId = "A"
    runRoomSwitchEffect(c);
    // Switch to roomId = "B" — effect re-runs.
    runRoomSwitchEffect(c);
    expect(calls).toEqual(['mark', 'mark']);
  });

  it('uses the latest onMarkRead via the ref mirror after a parent re-render', () => {
    // Simulate the parent passing a fresh callback identity (poll-driven
    // memo turnover) without changing roomId. The room-switch effect must
    // not re-run, but a future room switch must invoke the latest callback.
    const calls: string[] = [];
    const oldFn = () => calls.push('old');
    const newFn = () => calls.push('new');
    const c = createCoordinator(true, oldFn);

    runRoomSwitchEffect(c); // mount
    refreshOnMarkRead(c, newFn); // parent re-renders with a fresh fn
    // Room switches; effect re-runs and must invoke the *new* fn.
    runRoomSwitchEffect(c);

    expect(calls).toEqual(['old', 'new']);
  });
});

describe('useChatMarkRead — new-message effect', () => {
  it('calls onNewContent and onMarkRead when autoScrollEnabled is true', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const c = createCoordinator(true, onMarkRead);
    runNewMessageEffect(c, 'msg-1', true, onNewContent);
    expect(calls).toEqual(['new', 'mark']);
  });

  it('calls onNewContent but NOT onMarkRead when autoScrollEnabled is false', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const c = createCoordinator(false, onMarkRead);
    runNewMessageEffect(c, 'msg-1', false, onNewContent);
    expect(calls).toEqual(['new']);
  });

  it('does not fire when lastMessageId is null', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const c = createCoordinator(true, onMarkRead);
    runNewMessageEffect(c, null, true, onNewContent);
    expect(calls).toEqual([]);
  });

  it('fires once per fresh trailing id (no duplicate fires for the same id)', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const c = createCoordinator(true, onMarkRead);
    runNewMessageEffect(c, 'msg-1', true, onNewContent);
    // Same id again — autoScrollEnabled changed elsewhere etc, but the
    // trailing id has not advanced, so neither callback should fire.
    runNewMessageEffect(c, 'msg-1', true, onNewContent);
    expect(calls).toEqual(['new', 'mark']);
  });

  it('fires again when the trailing id advances', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const c = createCoordinator(true, onMarkRead);
    runNewMessageEffect(c, 'msg-1', true, onNewContent);
    runNewMessageEffect(c, 'msg-2', true, onNewContent);
    expect(calls).toEqual(['new', 'mark', 'new', 'mark']);
  });

  it('numeric ids work the same as string ids', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const c = createCoordinator(true, onMarkRead);
    runNewMessageEffect(c, 1, true, onNewContent);
    runNewMessageEffect(c, 1, true, onNewContent); // dedupe
    runNewMessageEffect(c, 2, true, onNewContent);
    expect(calls).toEqual(['new', 'mark', 'new', 'mark']);
  });
});

describe('useChatMarkRead — auto-scroll transition effect', () => {
  it('does NOT call onMarkRead on a true → false transition', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const c = createCoordinator(true, onMarkRead);
    runAutoScrollTransitionEffect(c, false);
    expect(calls).toEqual([]);
    expect(c.prevAutoScrollEnabled).toBe(false);
  });

  it('calls onMarkRead on a false → true transition', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const c = createCoordinator(false, onMarkRead);
    runAutoScrollTransitionEffect(c, true);
    expect(calls).toEqual(['mark']);
    expect(c.prevAutoScrollEnabled).toBe(true);
  });

  it('does not fire on steady-state true → true', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const c = createCoordinator(true, onMarkRead);
    runAutoScrollTransitionEffect(c, true);
    expect(calls).toEqual([]);
  });

  it('does not fire on steady-state false → false', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const c = createCoordinator(false, onMarkRead);
    runAutoScrollTransitionEffect(c, false);
    expect(calls).toEqual([]);
  });

  it('updates prevAutoScrollEnabled after each call regardless of branch', () => {
    const c = createCoordinator(true, () => {});
    runAutoScrollTransitionEffect(c, false);
    expect(c.prevAutoScrollEnabled).toBe(false);
    runAutoScrollTransitionEffect(c, true);
    expect(c.prevAutoScrollEnabled).toBe(true);
    runAutoScrollTransitionEffect(c, true);
    expect(c.prevAutoScrollEnabled).toBe(true);
  });
});

describe('useChatMarkRead — handleJumpToLatest', () => {
  it('calls jumpToLatest then onMarkRead in that order', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const jumpToLatest = () => calls.push('jump');
    const c = createCoordinator(true, onMarkRead);
    runHandleJumpToLatest(c, jumpToLatest);
    expect(calls).toEqual(['jump', 'mark']);
  });

  it('uses the latest onMarkRead via the ref mirror', () => {
    const calls: string[] = [];
    const oldFn = () => calls.push('old');
    const newFn = () => calls.push('new');
    const jumpToLatest = () => calls.push('jump');
    const c = createCoordinator(true, oldFn);
    refreshOnMarkRead(c, newFn);
    runHandleJumpToLatest(c, jumpToLatest);
    expect(calls).toEqual(['jump', 'new']);
  });
});

describe('useChatMarkRead — full sequencing scenarios', () => {
  it('worked example: enable auto-scroll, receive 3 msgs, toggle off, 2 more, toggle on', () => {
    // Mirrors the spec's worked example. We track every onMarkRead /
    // onNewContent call to verify unread accumulates only while auto-scroll
    // is off.
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');

    // Mount with autoScrollEnabled=true.
    const c = createCoordinator(true, onMarkRead);
    runRoomSwitchEffect(c); // mount: marks read
    expect(calls).toEqual(['mark']);

    // Receive 3 messages while auto-scroll is on; each one marks read.
    runNewMessageEffect(c, 'm1', true, onNewContent);
    runNewMessageEffect(c, 'm2', true, onNewContent);
    runNewMessageEffect(c, 'm3', true, onNewContent);
    expect(calls.filter((x) => x === 'mark').length).toBe(4); // mount + 3
    expect(calls.filter((x) => x === 'new').length).toBe(3);

    // Operator toggles auto-scroll OFF — no mark from transition.
    runAutoScrollTransitionEffect(c, false);
    expect(calls.filter((x) => x === 'mark').length).toBe(4);

    // Receive 2 more messages while auto-scroll is off; only onNewContent
    // fires, no mark.
    runNewMessageEffect(c, 'm4', false, onNewContent);
    runNewMessageEffect(c, 'm5', false, onNewContent);
    expect(calls.filter((x) => x === 'mark').length).toBe(4);
    expect(calls.filter((x) => x === 'new').length).toBe(5);

    // Operator toggles auto-scroll ON — transition marks read.
    runAutoScrollTransitionEffect(c, true);
    expect(calls.filter((x) => x === 'mark').length).toBe(5);
  });

  it('jump-to-latest while auto-scroll is off marks read once', () => {
    const calls: string[] = [];
    const onMarkRead = () => calls.push('mark');
    const onNewContent = () => calls.push('new');
    const jumpToLatest = () => calls.push('jump');

    const c = createCoordinator(false, onMarkRead);
    runRoomSwitchEffect(c); // mount
    runNewMessageEffect(c, 'm1', false, onNewContent);
    runNewMessageEffect(c, 'm2', false, onNewContent);
    // 2 unread accumulated. Operator clicks Jump-to-latest.
    runHandleJumpToLatest(c, jumpToLatest);
    // Sequence after mount: new, new, jump, mark.
    expect(calls).toEqual(['mark', 'new', 'new', 'jump', 'mark']);
  });
});
