---
name: typescript-async-safety
description: TypeScript type safety, async correctness, error handling, and immutability patterns. Language-level domain knowledge independent of framework.
axis: domain
origin: ECC-PSDE
---

# TypeScript Async and Safety Patterns

Type safety, async correctness, and error handling for TypeScript.

## When to Activate

- Writing or reviewing TypeScript code
- Working with async operations
- Handling errors at system boundaries
- Ensuring type safety in public APIs

## Type Safety

### Avoid `any`

```typescript
// BAD: Disables type checking entirely
function process(data: any): any { }

// GOOD: Use unknown and narrow
function process(data: unknown): Result {
  if (!isValidInput(data)) throw new Error('Invalid input')
  return transform(data) // data is narrowed
}
```

### No Non-Null Assertion Without Guard

```typescript
// BAD: Assertion without evidence
const name = user!.name

// GOOD: Runtime check first
if (!user) throw new Error('User not found')
const name = user.name
```

### Explicit Return Types on Public APIs

```typescript
// GOOD: Return type is part of the contract
export function calculateScore(items: Item[]): number { }
export async function fetchUser(id: string): Promise<User | null> { }

// Let TypeScript infer for local/private functions
const double = (n: number) => n * 2
```

## Async Correctness

### Parallelize Independent Work

```typescript
// BAD: Sequential when unnecessary
const users = await fetchUsers()
const projects = await fetchProjects()
const stats = await fetchStats()

// GOOD: Parallel execution
const [users, projects, stats] = await Promise.all([
  fetchUsers(),
  fetchProjects(),
  fetchStats(),
])
```

### Never Use async with forEach

```typescript
// BAD: forEach does not await
items.forEach(async (item) => {
  await processItem(item)  // Fire-and-forget, errors lost
})

// GOOD: for...of for sequential
for (const item of items) {
  await processItem(item)
}

// GOOD: Promise.all for parallel
await Promise.all(items.map(item => processItem(item)))
```

### No Floating Promises

Every async call must be `await`ed, `.catch()`ed, or explicitly voided:

```typescript
// BAD: Unhandled rejection
saveAnalytics(data)

// GOOD
await saveAnalytics(data)
// or
saveAnalytics(data).catch(err => logger.error(err))
// or (intentional fire-and-forget)
void saveAnalytics(data)
```

## Error Handling

### Never Swallow Errors

```typescript
// BAD
try { riskyOperation() } catch (e) { }

// GOOD
try {
  riskyOperation()
} catch (error) {
  logger.error('Operation failed:', error)
  throw error // or handle meaningfully
}
```

### Wrap JSON.parse

```typescript
// BAD: Throws on invalid input
const data = JSON.parse(rawString)

// GOOD
let data: unknown
try {
  data = JSON.parse(rawString)
} catch {
  throw new Error('Invalid JSON input')
}
```

### Throw Error Objects

```typescript
// BAD
throw 'something went wrong'
throw { message: 'error' }

// GOOD
throw new Error('something went wrong')
```

## Immutability

```typescript
// GOOD: Spread operator
const updated = { ...user, name: 'New Name' }
const appended = [...items, newItem]

// BAD: Direct mutation
user.name = 'New Name'
items.push(newItem)

// GOOD: Functional state updates in React
setCount(prev => prev + 1)

// BAD: Stale reference in async context
setCount(count + 1)
```
