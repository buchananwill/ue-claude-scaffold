---
name: react-component-discipline
description: Use when writing, reviewing, or refactoring React components — especially those with hooks, callbacks, modals, or store interactions. Enforces separation of data logic from UI, keeps dependency arrays small enough to reason about, and prevents the emergent complexity bugs (infinite render loops, stale closures) that arise when components accumulate too many concerns. Use this skill whenever you see a useCallback or useMemo with more than five dependencies, a component file over 150 lines, or any mix of store orchestration and JSX in the same function.
---

# React Component Discipline

## The Core Rule

Hooks do data logic. Components do UI. Never both in the same function body.

A React component's job is to accept props, render JSX, and wire user events to
callbacks. The moment it starts building composite keys, diffing sets, reading
stores point-in-time, or assembling draft records — it has become a domain logic
function wearing a React costume. Domain logic in a component cannot be tested
without rendering. It cannot be reused without copy-pasting the component. And
its dependency arrays grow until no human can reason about render stability.

## The Value of Type Constraints

Generics, type parameters, and typed props are not boilerplate noise. They are
landing lights. They are cat's eyes on a windy mountain road. They are poles
marking which slope is safely groomed snowpack and which could be millimetres
of powder hiding a painful helicopter flight home.

`Record<string, unknown>` looks cheap. It costs everything: React cannot tell
what changed, every render is suspect, every dependency array is a guess. A
typed generic like `IdInnerCellProps<ColorDto>` looks expensive. It is free at
runtime — and at compile time it proves the cell can only receive what it
declared. The type system enforces the render firewall that no amount of
careful `useMemo` dependency lists can replicate, because the type system
catches violations before the code runs, while dependency arrays fail silently
at runtime in 16,384 possible states.

Prefer typed generics over permissive records. The compile-time cost is the
investment. The runtime stability is the return.

## The Finger Rule

Count the dependencies in a `useCallback` or `useMemo` array. Use your fingers.
If you run out of fingers on one hand, the function has too many responsibilities.
If you run out of fingers on two hands, the function is a guaranteed source of
bugs — stale closures, infinite render loops, or both — because the state space
is combinatorially intractable. Each dependency is a boolean ("did it change?").
Ten dependencies is 1,024 possible states. Fourteen is 16,384.

No human can reason about which combination produces a stable render and which
produces a cycle. The fix is never "find the one unstable reference." The fix is:
make the dependency arrays small enough to hold in your hand.

### Thresholds

- **0-2 dependencies**: Normal. Easy to verify stability.
- **3-5 dependencies**: Acceptable. Review each for reference stability.
- **6+ dependencies**: The function does too much. Decompose before proceeding.

## Covariant Data

Values that always travel together and describe the same concept are covariant.
They must be bundled into a single object, not scattered as loose primitives.

**Symptoms of missing covariant grouping:**

- The same 3+ variables appear in multiple dependency arrays
- A function accepts parameters that are never varied independently
- Two parameters share a prefix or suffix (e.g., `discriminatorColumn`,
  `discriminatorValue`)
- A pure function is wrapped in `useCallback` solely because it closes over
  scattered locals

When you see these symptoms, the code is missing a data type. Name the concept.
Create the object. Pass one thing instead of five.

### False separation

If two parameters are covariant — one implies the other — passing both is a
false degree of freedom. A junction table name implies its FK column names.
A discriminator column implies its value domain. Passing `table` and
`parentFkColumn` as independent strings pretends they can vary independently
when they cannot. This is not flexibility — it is surface area for bugs.

## Layered Architecture

Structure React code in three layers:

### 1. Domain logic (pure functions, no React)

Pure functions and data types that express business rules. No hooks, no JSX,
no React imports. Testable with plain unit tests. Examples:

- Composite key construction
- Set diffing (additions and removals)
- Record assembly (building a draft row from typed fields)
- Validation and coercion

These live in `lib/` or `utils/` and import nothing from React.

### 2. Data hooks (React hooks, no JSX)

Custom hooks that compose domain logic with React state, stores, and queries.
Each hook has a single, named responsibility. Returns a stable interface.
Examples:

- `useTagSession` — manages snapshot, local edits, and confirm/cancel lifecycle
- `useJunctionPatches` — subscribes to dirty store for a specific table
- `useFilteredList` — filters a list by a search string

Hooks are the smart layer. They are small, generic, and independently testable
via `renderHook`. Their return types are their API contract.

### 3. Components (JSX, minimal logic)

Components receive data and callbacks from hooks. They render JSX. They wire
event handlers. They do not compute, diff, build records, or read stores.

A component should be dumb enough that changing its visual design (different
layout, different component library, different styling approach) requires
touching zero data logic. If restyling a component forces you to wade through
hook dependency arrays, the boundary is wrong.

## Anti-Patterns

### The God Callback

A single `useCallback` that handles confirm/submit by doing everything: diffing
state, building records, calling multiple store actions, and closing the modal.
Its dependency array is a receipt for every concern it should have delegated.

**Fix:** The callback should call one function: `session.confirm()`. That function
lives in a hook or in pure domain logic. The callback's dependency array has one
entry.

### Null-as-Sentinel

Using `null` in a state variable to mean "this feature is inactive" (e.g.,
`localTagIds: Set<number> | null` where `null` means "modal closed"). This
overloads the variable with lifecycle semantics, forces null-checks in every
consumer, and makes the dependency graph branch on a value that has nothing
to do with the data.

**Fix:** Separate the lifecycle (`isOpen`) from the data (`editBuffer`). Or
bundle them into a session object where `null` session means closed and a
present session always has valid state.

### Loose Primitives

Destructuring a typed object into five local variables at the component top,
then threading those variables through every hook and callback as individual
parameters. The object had a name and a shape. The variables have neither.

**Fix:** Pass the object. If the object is too large, it contains multiple
covariant groups — split it into named sub-objects, not into unnamed locals.

### Snapshot Amnesia

Claiming to operate on a snapshot (captured at modal open) but reading live
query data at confirm time because the snapshot only captured IDs, not the
full objects needed downstream. The snapshot is incomplete because the
component never modelled "session state" as a coherent concept.

**Fix:** Snapshot everything the confirm path needs, at open time, into one
object. The confirm path reads only from the snapshot — zero live queries.

## Review Checklist

When reviewing or writing a React component, verify:

1. Every `useCallback` and `useMemo` has five or fewer dependencies
2. No dependency appears in three or more arrays (covariant grouping needed)
3. No pure functions are wrapped in `useCallback` (hoist them)
4. The component body contains no logic that could run without React
5. The component file is under 150 lines (extract hooks or sub-components)
6. Null is not used as a lifecycle sentinel in data state
7. Store reads inside callbacks use snapshots, not live subscriptions
8. Restyling the component would not require touching any hook or callback
