---
name: proc-geo-test-format
description: Test file structure, imports, fixtures, and assertion patterns for procedural-geometry-ideas using Jest with ts-jest. Covers geometry-specific tolerance and metamorphic property testing.
axis: schema
---

# Procedural Geometry Test Format

Tests for `@proc-geo/core` live in `packages/core/tests/` as `*.test.ts`, mirroring the
`src/` subdirectory they exercise (`tests/straight-skeleton/`, `tests/random-polygon/`).

## Runner: Jest with ts-jest — Never Vitest

Config is `packages/core/jest.config.cjs`: `testEnvironment: 'node'`, CommonJS transform
(`useESM: false`), `testMatch: ['<rootDir>/tests/**/*.test.ts']`.

**Do not use Vitest, `node:test`, or React Testing Library.** None are installed. Import
`describe`/`it`/`expect` from Jest's globals — no import statement is needed for them.

`moduleNameMapper` resolves `@proc-geo/core` and `@proc-geo/test-fixtures` straight to
**source**, so tests run without a prior build. Always import across package boundaries by
package name, never by a relative path that escapes the package.

## Template

```typescript
import { solveSkeleton } from '@proc-geo/core'
import { ALL_TEST_POLYGONS, SQUARE } from '@proc-geo/test-fixtures'

describe('solveSkeleton', () => {
  it('completes on a square', () => {
    const result = solveSkeleton(SQUARE)
    expect(result.complete).toBe(true)
    expect(result.diagnostics).toHaveLength(0)
  })
})
```

## Fixtures

`@proc-geo/test-fixtures` exports named polygons plus the `ALL_TEST_POLYGONS` list. Several
suites sweep that list asserting every entry solves completely.

**A known-failing fixture must be exported individually but kept OUT of `ALL_TEST_POLYGONS`**,
or it breaks every sweeping suite at once. When a spec tells you to "add the fixture" for a
defect that is not yet fixed, add it as an individual export and give it a dedicated test that
documents the current behaviour — do not add it to the sweep list until it passes.

## Floating-Point Assertions

Geometry is numeric. Never assert exact equality on computed coordinates.

- Use `expect(actual).toBeCloseTo(expected, digits)` for scalars.
- For points and vectors, assert each component with `toBeCloseTo`, or compare through the
  project's own `areEqual` / `fp_compare` helpers in `core-functions.ts`.
- Pick the tolerance from what the spec states. Where a spec gives a measured bound (for
  example "agreement within 3.3e-15"), assert against that bound rather than inventing a
  looser one.
- `FLOATING_POINT_EPSILON` (`constants.ts`) is the solver's degeneracy band. It is **not**
  automatically the right test tolerance, and where a spec introduces a separate noise floor,
  the two are deliberately orders of magnitude apart — do not conflate them.

## Metamorphic Property Tests

Some specifications state invariants rather than expected coordinates — "output is invariant
under silhouette-preserving vertex insertion", for instance. These are the strongest tests
available here because they need no golden values.

Express them as: generate a transformed input that must not change the observable, run both,
and assert the **observable only**. Be precise about what the observable is — if a spec says
the observable is the tiling and the lot set, then vertex lists, edge ids, and internal
partitions are explicitly free to differ, and asserting on them is a bug in the test.

## Running

```bash
pnpm --filter @proc-geo/core test
pnpm --filter @proc-geo/core test -- --testPathPatterns=core-functions
```

Debug-oriented suites already exist (`*-debug.test.ts`, `fuzz-*.test.ts`) and are part of the
gate. If your change makes one fail, that is a real regression — investigate it rather than
adjusting the test to match new behaviour, unless the spec explicitly supersedes it.
</content>
