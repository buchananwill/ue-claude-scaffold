import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import type { RefCallback, RefObject } from 'react';

const BOTTOM_THRESHOLD = 80; // px from bottom to consider "at bottom"

interface UseAutoScrollOptions {
  /**
   * When false, onNewContent skips auto-scrolling and always raises the
   * jump-to-latest indicator instead. Defaults to true.
   */
  enabled?: boolean;
}

interface UseAutoScrollResult {
  /** Ref to attach to the ScrollArea viewport */
  viewportRef: RefCallback<HTMLDivElement>;
  /** Ref for the sentinel element at the end of the list */
  sentinelRef: RefObject<HTMLDivElement | null>;
  /** Whether the user is currently scrolled near the bottom */
  isAtBottom: boolean;
  /**
   * Whether to show a "jump to latest" indicator.
   * This becomes true only when new content arrives (via onNewContent) while
   * the user is scrolled away from the bottom. It does NOT activate on
   * scroll-up alone -- it requires new content to trigger.
   */
  showJumpToLatest: boolean;
  /** Scroll to the bottom */
  jumpToLatest: () => void;
  /** Call when new messages arrive to trigger auto-scroll or show indicator */
  onNewContent: () => void;
}

export function useAutoScroll(options?: UseAutoScrollOptions): UseAutoScrollResult {
  const enabled = options?.enabled ?? true;

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const viewportEl = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const prevEnabledRef = useRef(enabled);

  const checkBottom = useCallback(() => {
    const el = viewportEl.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    if (atBottom) {
      setShowJumpToLatest(false);
    }
  }, []);

  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Detach old listener
      if (viewportEl.current) {
        viewportEl.current.removeEventListener('scroll', checkBottom);
      }
      viewportEl.current = node;
      if (node) {
        node.addEventListener('scroll', checkBottom, { passive: true });
        checkBottom();
      }
    },
    [checkBottom],
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (viewportEl.current) {
        viewportEl.current.removeEventListener('scroll', checkBottom);
      }
    };
  }, [checkBottom]);

  // When the toggle flips false → true, scroll to the sentinel and clear the
  // jump-to-latest indicator so the operator catches up to the live tail.
  useEffect(() => {
    if (!prevEnabledRef.current && enabled) {
      requestAnimationFrame(() => {
        sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
        setShowJumpToLatest(false);
      });
    }
    prevEnabledRef.current = enabled;
  }, [enabled]);

  const jumpToLatest = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowJumpToLatest(false);
  }, []);

  const onNewContent = useCallback(() => {
    if (!enabledRef.current) {
      setShowJumpToLatest(true);
      return;
    }
    if (isAtBottomRef.current) {
      // Auto-scroll
      requestAnimationFrame(() => {
        sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    } else {
      setShowJumpToLatest(true);
    }
  }, []);

  return {
    viewportRef,
    sentinelRef,
    isAtBottom,
    showJumpToLatest,
    jumpToLatest,
    onNewContent,
  };
}
