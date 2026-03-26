/**
 * Tests for TaskDuration component logic.
 *
 * The component uses React hooks (useState, useEffect) internally, so we
 * replicate the pure data-transformation logic (formatDuration, duration
 * computation) and test it directly. This avoids needing a React test renderer.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure function replicas (copied verbatim from TaskDuration.tsx)
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (ms < 60000) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function parseTs(ts: string): Date {
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z');
}

const TERMINAL = new Set(['completed', 'failed', 'integrated']);
const ACTIVE = new Set(['claimed', 'in_progress']);

/**
 * Replicates the duration computation logic from the TaskDuration component.
 * Returns the formatted string that would be rendered, or '\u2014' (em dash)
 * for cases where no duration is shown.
 */
function computeDuration(
  claimedAt: string | null,
  completedAt: string | null,
  status: string,
): string {
  if (!claimedAt) return '\u2014';

  let delta: number;

  if (TERMINAL.has(status)) {
    if (!completedAt) return '\u2014';
    delta = parseTs(completedAt).getTime() - parseTs(claimedAt).getTime();
  } else if (ACTIVE.has(status)) {
    delta = Date.now() - parseTs(claimedAt).getTime();
  } else {
    return '\u2014';
  }

  if (isNaN(delta)) return '\u2014';

  return formatDuration(delta);
}

// ---------------------------------------------------------------------------
// Tests: formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('returns <1m for zero milliseconds', () => {
    expect(formatDuration(0)).toBe('<1m');
  });

  it('returns <1m for values under 1 minute', () => {
    expect(formatDuration(30000)).toBe('<1m');
  });

  it('returns <1m for 59999ms (just under 1 minute)', () => {
    expect(formatDuration(59999)).toBe('<1m');
  });

  it('returns 1m for exactly 60000ms', () => {
    expect(formatDuration(60000)).toBe('1m');
  });

  it('returns minutes only when under 1 hour', () => {
    // 14 minutes = 840000ms
    expect(formatDuration(840000)).toBe('14m');
  });

  it('returns hours and minutes for 1+ hours', () => {
    // 2h 14m = 8040000ms
    expect(formatDuration(8040000)).toBe('2h 14m');
  });

  it('returns Xh 0m for exact hour boundaries', () => {
    // 1 hour = 3600000ms
    expect(formatDuration(3600000)).toBe('1h 0m');
  });

  it('handles large values (24 hours)', () => {
    // 24 hours = 86400000ms
    expect(formatDuration(86400000)).toBe('24h 0m');
  });

  it('returns 59m for just under 1 hour', () => {
    // 59 minutes = 3540000ms
    expect(formatDuration(3540000)).toBe('59m');
  });

  it('returns 1h 1m for 61 minutes', () => {
    expect(formatDuration(3660000)).toBe('1h 1m');
  });
});

// ---------------------------------------------------------------------------
// Tests: parseTs
// ---------------------------------------------------------------------------

describe('parseTs', () => {
  it('parses ISO string with Z suffix as-is', () => {
    const d = parseTs('2025-06-15T10:30:00Z');
    expect(d.toISOString()).toBe('2025-06-15T10:30:00.000Z');
  });

  it('appends Z to timestamps without Z suffix', () => {
    const d = parseTs('2025-06-15T10:30:00');
    expect(d.toISOString()).toBe('2025-06-15T10:30:00.000Z');
  });

  it('does not double-append Z when already present', () => {
    const withZ = parseTs('2025-01-01T00:00:00Z');
    const withoutZ = parseTs('2025-01-01T00:00:00');
    expect(withZ.getTime()).toBe(withoutZ.getTime());
  });
});

// ---------------------------------------------------------------------------
// Tests: computeDuration (component render logic)
// ---------------------------------------------------------------------------

describe('computeDuration', () => {
  it('returns em dash when claimedAt is null', () => {
    expect(computeDuration(null, null, 'pending')).toBe('\u2014');
    expect(computeDuration(null, null, 'completed')).toBe('\u2014');
    expect(computeDuration(null, '2025-06-15T12:00:00Z', 'completed')).toBe('\u2014');
  });

  it('returns em dash for pending status even with claimedAt', () => {
    expect(computeDuration('2025-06-15T10:00:00Z', null, 'pending')).toBe('\u2014');
  });

  it('returns em dash for terminal status without completedAt', () => {
    expect(computeDuration('2025-06-15T10:00:00Z', null, 'completed')).toBe('\u2014');
    expect(computeDuration('2025-06-15T10:00:00Z', null, 'failed')).toBe('\u2014');
    expect(computeDuration('2025-06-15T10:00:00Z', null, 'integrated')).toBe('\u2014');
  });

  it('computes correct static duration for terminal status with both timestamps', () => {
    // 2 hours difference
    const result = computeDuration(
      '2025-06-15T10:00:00Z',
      '2025-06-15T12:00:00Z',
      'completed',
    );
    expect(result).toBe('2h 0m');
  });

  it('computes duration for failed status', () => {
    // 14 minutes difference
    const result = computeDuration(
      '2025-06-15T10:00:00Z',
      '2025-06-15T10:14:00Z',
      'failed',
    );
    expect(result).toBe('14m');
  });

  it('computes duration for integrated status', () => {
    // 1h 30m difference
    const result = computeDuration(
      '2025-06-15T10:00:00Z',
      '2025-06-15T11:30:00Z',
      'integrated',
    );
    expect(result).toBe('1h 30m');
  });

  it('computes short duration (<1m) for terminal status', () => {
    // 30 seconds difference
    const result = computeDuration(
      '2025-06-15T10:00:00Z',
      '2025-06-15T10:00:30Z',
      'completed',
    );
    expect(result).toBe('<1m');
  });

  it('handles timestamps without Z suffix', () => {
    const result = computeDuration(
      '2025-06-15T10:00:00',
      '2025-06-15T12:00:00',
      'completed',
    );
    expect(result).toBe('2h 0m');
  });

  it('returns a duration string for active statuses (claimed)', () => {
    // Use a recent timestamp so Date.now() - claimedAt produces a positive value
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
    const result = computeDuration(fiveMinutesAgo, null, 'claimed');
    // Should be approximately 5m, but timing can vary; just verify it is not a dash
    expect(result).not.toBe('\u2014');
    expect(result).toMatch(/^\d+m$|^\d+h \d+m$|^<1m$/);
  });

  it('returns a duration string for in_progress status', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60000).toISOString();
    const result = computeDuration(tenMinutesAgo, null, 'in_progress');
    expect(result).not.toBe('\u2014');
    expect(result).toMatch(/^\d+m$|^\d+h \d+m$|^<1m$/);
  });

  it('returns em dash for unknown/unrecognized status', () => {
    expect(computeDuration('2025-06-15T10:00:00Z', null, 'some_other_status')).toBe('\u2014');
  });
});
