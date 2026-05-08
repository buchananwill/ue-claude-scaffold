/**
 * Coordinates the "mark room read" callback against three triggers:
 *   1. Room switch: when `roomId` changes, the new room's unread count is
 *      cleared.
 *   2. New trailing message: when `lastMessageId` changes, the auto-scroll
 *      hook is told via `onNewContent`. If `autoScrollEnabled` is true the
 *      room is also marked read so the unread count stays at zero while the
 *      operator is following the live tail.
 *   3. Auto-scroll false → true transition: when the operator re-enables
 *      auto-scroll the unread count is cleared (the `useAutoScroll` hook
 *      handles the scroll-to-sentinel side itself).
 *
 * In addition the hook exposes a memoised `handleJumpToLatest` callback that
 * scrolls to the live tail and marks the room read in one click.
 *
 * The latest `onMarkRead` is mirrored into a ref so that effects keyed on
 * other dependencies (`roomId`, `autoScrollEnabled`) don't re-run merely
 * because the parent passed a fresh callback identity. The pure predicates in
 * `chatTimelineHelpers.ts` answer "should we mark read in this branch?";
 * this hook owns the React-side wiring.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  shouldMarkReadOnAutoScrollTransition,
  shouldMarkReadOnNewMessage,
} from '../components/chatTimelineHelpers.ts';

export interface UseChatMarkReadInput {
  roomId: string;
  autoScrollEnabled: boolean;
  onMarkRead: () => void;
  lastMessageId: string | number | null;
  onNewContent: () => void;
  jumpToLatest: () => void;
}

export interface UseChatMarkReadOutput {
  handleJumpToLatest: () => void;
}

export function useChatMarkRead(input: UseChatMarkReadInput): UseChatMarkReadOutput {
  const { roomId, autoScrollEnabled, onMarkRead, lastMessageId, onNewContent, jumpToLatest } = input;

  // Mirror the latest onMarkRead so effects keyed on other deps don't re-run
  // when the parent passes a fresh callback identity (poll-driven memo
  // turnover).
  const onMarkReadRef = useRef(onMarkRead);
  useLayoutEffect(() => {
    onMarkReadRef.current = onMarkRead;
  }, [onMarkRead]);

  // Track the previously-rendered auto-scroll preference so the transition
  // effect can detect a false → true edge.
  const prevAutoScrollEnabledRef = useRef(autoScrollEnabled);

  // Track the last message id we acted on so the new-message effect fires
  // exactly once per fresh trailing id.
  const lastSeenIdRef = useRef<string | number | null>(null);

  // Reset unread count on room switch only — not on every poll-driven
  // identity change of onMarkRead.
  useEffect(() => {
    onMarkReadRef.current();
  }, [roomId]);

  useEffect(() => {
    if (lastMessageId !== null && lastMessageId !== lastSeenIdRef.current) {
      lastSeenIdRef.current = lastMessageId;
      onNewContent();
      if (shouldMarkReadOnNewMessage(autoScrollEnabled)) {
        onMarkReadRef.current();
      }
    }
  }, [lastMessageId, onNewContent, autoScrollEnabled]);

  // On a false → true transition of the global toggle, clear the unread
  // count. The useAutoScroll hook itself handles the scroll-to-sentinel.
  useEffect(() => {
    if (shouldMarkReadOnAutoScrollTransition(prevAutoScrollEnabledRef.current, autoScrollEnabled)) {
      onMarkReadRef.current();
    }
    prevAutoScrollEnabledRef.current = autoScrollEnabled;
  }, [autoScrollEnabled]);

  const handleJumpToLatest = useCallback(() => {
    jumpToLatest();
    onMarkReadRef.current();
  }, [jumpToLatest]);

  return { handleJumpToLatest };
}
