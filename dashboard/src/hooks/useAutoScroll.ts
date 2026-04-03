import { useState, useCallback, useRef, useEffect } from 'react';

const BOTTOM_THRESHOLD = 80; // px from bottom to consider "at bottom"

interface UseAutoScrollResult {
  /** Ref to attach to the ScrollArea viewport */
  viewportRef: React.RefCallback<HTMLDivElement>;
  /** Ref for the sentinel element at the end of the list */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
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

export function useAutoScroll(): UseAutoScrollResult {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const viewportEl = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);

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

  const jumpToLatest = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowJumpToLatest(false);
  }, []);

  const onNewContent = useCallback(() => {
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
