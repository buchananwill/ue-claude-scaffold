/**
 * Tests for useAutoScrollPreference's pure logic.
 *
 * The hook itself uses React context + state; we replicate its localStorage
 * parsing logic verbatim and test it directly. This mirrors the codebase
 * pattern (see useTaskFilters.test.ts) and avoids needing a React renderer.
 *
 * The branches under test are the malformed-input default ("garbage" / "")
 * and the explicit "off" / "on" round-trip via setEnabled's serialiser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Pure function replicas (mirror useAutoScrollPreference.tsx)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dashboard.autoScroll';

function readInitialEnabled(getter: (key: string) => string | null): boolean {
  try {
    const raw = getter(STORAGE_KEY);
    return raw !== 'off';
  } catch {
    return true;
  }
}

function serialiseEnabled(v: boolean): string {
  return v ? 'on' : 'off';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readInitialEnabled', () => {
  it('returns true when localStorage is empty', () => {
    expect(readInitialEnabled(() => null)).toBe(true);
  });

  it('returns true when stored value is the literal "on"', () => {
    expect(readInitialEnabled(() => 'on')).toBe(true);
  });

  it('returns false when stored value is the literal "off"', () => {
    expect(readInitialEnabled(() => 'off')).toBe(false);
  });

  it('returns true for a malformed value (the spec default)', () => {
    expect(readInitialEnabled(() => 'garbage')).toBe(true);
  });

  it('returns true for an empty-string value', () => {
    expect(readInitialEnabled(() => '')).toBe(true);
  });

  it('returns true when the getter throws (storage disabled)', () => {
    expect(
      readInitialEnabled(() => {
        throw new Error('storage disabled');
      }),
    ).toBe(true);
  });
});

describe('serialiseEnabled', () => {
  it('serialises true as "on"', () => {
    expect(serialiseEnabled(true)).toBe('on');
  });

  it('serialises false as "off"', () => {
    expect(serialiseEnabled(false)).toBe('off');
  });
});

describe('round-trip', () => {
  it('"on" parses back to true', () => {
    const stored = serialiseEnabled(true);
    expect(readInitialEnabled(() => stored)).toBe(true);
  });

  it('"off" parses back to false', () => {
    const stored = serialiseEnabled(false);
    expect(readInitialEnabled(() => stored)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage-side-effect tests (simulating setEnabled's writer)
// ---------------------------------------------------------------------------

type SetItemFn = (key: string, value: string) => void;

describe('setEnabled storage writer', () => {
  let store: Map<string, string>;
  let setItem: ReturnType<typeof vi.fn<SetItemFn>>;

  beforeEach(() => {
    store = new Map();
    setItem = vi.fn<SetItemFn>((key, value) => {
      store.set(key, value);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setEnabled(v: boolean) {
    try {
      setItem(STORAGE_KEY, serialiseEnabled(v));
    } catch {
      // Safari private mode and storage-disabled environments throw on setItem.
      // Failures are silent; in-memory state still updates.
    }
  }

  it('writes "on" when set to true', () => {
    setEnabled(true);
    expect(store.get(STORAGE_KEY)).toBe('on');
  });

  it('writes "off" when set to false', () => {
    setEnabled(false);
    expect(store.get(STORAGE_KEY)).toBe('off');
  });

  it('overwrites previous value', () => {
    setEnabled(true);
    setEnabled(false);
    expect(store.get(STORAGE_KEY)).toBe('off');
  });

  it('does not throw when underlying storage throws', () => {
    setItem.mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => setEnabled(true)).not.toThrow();
  });
});
