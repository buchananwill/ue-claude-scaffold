---
name: typescript-type-discipline
description: When, where, and why to define named types. Prohibits ad hoc inline types and directs agents to remap core project types using TypeScript's type meta-functions.
axis: protocol
---

# TypeScript Type Discipline

Rules for defining, organizing, and reusing types to maintain a consistent, navigable codebase.

## Core Rule

**Never define types inline.** Every type that appears in a function signature, component prop, return value, or variable declaration must be a named, exported type or interface. No anonymous object shapes in signatures.

```typescript
// BAD: Ad hoc inline type
function createUser(data: { name: string; email: string; role: 'admin' | 'user' }): { id: string; createdAt: Date } {
  // ...
}

// BAD: Inline props
function UserCard({ name, email }: { name: string; email: string }) { }

// GOOD: Named and exported
export interface CreateUserInput {
  name: string
  email: string
  role: UserRole
}

export interface CreateUserResult {
  id: string
  createdAt: Date
}

function createUser(data: CreateUserInput): CreateUserResult { }
```

## Remap, Don't Duplicate

When you need a subset, variant, or transformation of an existing type, derive it — never copy fields by hand.

```typescript
// BAD: Manual copy of fields from User
interface UserFormData {
  name: string    // duplicated from User
  email: string   // duplicated from User
  bio: string     // duplicated from User
}

// GOOD: Derived from the source type
type UserFormData = Pick<User, 'name' | 'email' | 'bio'>

// GOOD: Partial for patch payloads
type UserPatch = Partial<Pick<User, 'name' | 'email' | 'bio'>>

// GOOD: Omit internal fields for API responses
type PublicUser = Omit<User, 'passwordHash' | 'deletedAt'>
```

If a type can be expressed as a transformation of a core project type, it **must** be. Hand-copying fields creates silent drift when the source type changes.

## Where to Define Types

### Dedicated Types Files

Types shared across multiple files belong in a dedicated types file:

- `types.ts` at the module or feature directory level
- Co-located with the code that uses them, not in a global `types/` catch-all

### Co-located with Implementation

Types used by a single file may live at the top of that file, but must still be named and exported. If a second file needs the type, move it to a shared types file immediately.

### Never Bury Types

Do not define types inside function bodies, inside conditionals, or as local aliases that shadow broader types. Types are declarations — they belong at module scope.

## Naming Conventions

- **Interfaces and types**: PascalCase. Name reflects the domain concept, not the shape.
- **Props types**: `{ComponentName}Props` — e.g., `UserCardProps`, `TaskListProps`.
- **Input/output types**: `{Operation}Input`, `{Operation}Result` — e.g., `CreateUserInput`, `CreateUserResult`.
- **Enums and unions**: name the concept — `UserRole`, `TaskStatus`, not `RoleEnum` or `StatusType`.

## Export by Default

Export every named type unless it is genuinely private to a single function. The cost of an unused export is zero. The cost of a missing export is a duplicated type.

## Generics Over Ad Hoc Variants

When multiple types share the same shape but differ by a parameter, extract a generic:

```typescript
// BAD: Separate types for each entity's list response
interface UserListResponse { items: User[]; total: number; page: number }
interface ProjectListResponse { items: Project[]; total: number; page: number }

// GOOD: One generic
interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
}
```

## Review Checklist

When writing or reviewing TypeScript:

1. **No inline object types** in function signatures, props, or return types
2. **No hand-copied fields** — use `Pick`, `Omit`, `Partial`, or a custom mapped type
3. **Every type is named** and lives at module scope
4. **Shared types are exported** and in a discoverable location
5. **Variants are derived** from core types, not defined independently
6. **Generics replace repetition** when multiple types share structure
