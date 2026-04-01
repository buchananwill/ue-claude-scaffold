---
name: typescript-type-remapping
description: TypeScript mapped types, conditional types, key iteration, and type-level meta-functions. Domain knowledge for reshaping and constraining types without runtime cost.
axis: domain
---

# TypeScript Type Remapping

Type-level meta-functions for reshaping, constraining, and deriving types from existing ones.

## When to Activate

- Defining types derived from existing project types
- Constraining generic parameters
- Building API boundaries, form types, or DTOs from core domain types
- Reviewing code that uses `Pick`, `Omit`, `Partial`, or custom mapped types

## Built-in Utility Types

### Reshaping with Pick and Omit

```typescript
// Narrow a large type to what a component actually needs
type UserSummary = Pick<User, 'id' | 'name' | 'avatarUrl'>

// Remove internal fields before exposing to an API
type PublicProject = Omit<Project, 'internalNotes' | 'deletedAt'>
```

### Partial, Required, Readonly

```typescript
// Patch payloads: every field optional
type UserPatch = Partial<Pick<User, 'name' | 'email' | 'bio'>>

// Enforce completeness after validation
type ValidatedConfig = Required<RawConfig>

// Freeze a type for safe sharing
type FrozenState = Readonly<AppState>
```

### Record for Uniform Shape

```typescript
// Map a union of keys to a uniform value type
type FeatureFlags = Record<'darkMode' | 'betaEditor' | 'newNav', boolean>

// Dynamic but typed lookup tables
type ScoresByPlayer = Record<string, number>
```

## Mapped Types and Key Iteration

### Iterating Over Keys

The `[K in keyof T]` pattern lets you transform every property of a type:

```typescript
// Make every property nullable
type Nullable<T> = { [K in keyof T]: T[K] | null }

// Make every property a getter function
type Getters<T> = { [K in keyof T]: () => T[K] }
```

### Key Remapping with `as`

```typescript
// Prefix every key
type Prefixed<T, P extends string> = {
  [K in keyof T as `${P}${Capitalize<string & K>}`]: T[K]
}
// Prefixed<{ name: string; age: number }, 'user'>
// => { userName: string; userAge: number }
```

### Filtering Keys

```typescript
// Keep only string-valued properties
type StringFields<T> = {
  [K in keyof T as T[K] extends string ? K : never]: T[K]
}
```

## Conditional Types

### Basics

```typescript
type IsString<T> = T extends string ? true : false

// Extract array element type
type ElementOf<T> = T extends (infer E)[] ? E : never
```

### Distributive Conditionals

When `T` is a union, conditional types distribute across each member:

```typescript
type NonNullable<T> = T extends null | undefined ? never : T
// NonNullable<string | null | number> => string | number
```

## The `never` Type as a Constraint Tool

### Excluding Forbidden Values

`never` in a union disappears. Use it to eliminate invalid members:

```typescript
// Exclude specific union members
type WithoutAdmin = Exclude<Role, 'admin'>

// Extract only members matching a shape
type StringEvents = Extract<Event, { payload: string }>
```

### Validating Generic Parameters

Use `never` as the return type of a conditional to reject invalid inputs at the type level:

```typescript
// Only accept object types, not primitives
type KeysOf<T> = T extends object ? keyof T : never

// Constrain to types that have an 'id' field
type IdOf<T> = T extends { id: infer I } ? I : never
```

### Prohibiting Specific Properties

Set forbidden keys to `never` so any assignment is a type error:

```typescript
type NoMetadata<T> = T & { metadata?: never; _internal?: never }

// More general: forbid a set of keys
type Forbid<T, Keys extends string> = T & { [K in Keys]?: never }
```

## Template Literal Types

```typescript
type EventName = `on${Capitalize<'click' | 'hover' | 'focus'>}`
// => 'onClick' | 'onHover' | 'onFocus'

type Endpoint = `/${string}/${string}`
// Matches any two-segment path
```

## Combining Patterns

Real-world types compose these primitives:

```typescript
// A form type: pick editable fields, make them optional, add validation state
type FormState<T, EditableKeys extends keyof T> = {
  values: Partial<Pick<T, EditableKeys>>
  errors: Partial<Record<EditableKeys, string>>
  touched: Partial<Record<EditableKeys, boolean>>
}

// Extract only async methods from a service
type AsyncMethods<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => Promise<any> ? K : never]: T[K]
}
```
