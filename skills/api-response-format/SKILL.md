---
name: api-response-format
description: Consistent API response shapes, input validation schemas, and server action return types for TypeScript backends.
axis: schema
origin: ECC-PSDE
---

# API Response Format

Consistent shapes for API responses, validated inputs, and server action returns.

## When to Activate

- Defining API route response types
- Writing server actions
- Validating request inputs with Zod
- Returning errors from endpoints

## Response Envelope

```typescript
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string }

// With pagination
type PaginatedResponse<T> = ApiResponse<T> & {
  meta?: { total: number; page: number; limit: number }
}
```

## Server Action Return Shape

```typescript
'use server'

import { z } from 'zod'

const schema = z.object({
  name: z.string().min(1).max(100),
})

export async function createProject(formData: FormData) {
  const parsed = schema.safeParse({ name: formData.get('name') })
  if (!parsed.success) {
    return { success: false, error: parsed.error.flatten() }
  }

  // ... perform action

  if (error) return { success: false, error: 'Failed to create project' }
  return { success: true, data }
}
```

## Input Validation Pattern

Always validate at system boundaries using Zod:

```typescript
import { z } from 'zod'

const CreateItemSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  endDate: z.string().datetime(),
  categories: z.array(z.string()).min(1),
})

export async function POST(request: Request) {
  const body = await request.json()

  const result = CreateItemSchema.safeParse(body)
  if (!result.success) {
    return Response.json(
      { success: false, error: 'Validation failed', details: result.error.errors },
      { status: 400 }
    )
  }

  // Proceed with result.data (fully typed)
}
```

## Error Response Rules

- Generic messages to clients (`'An error occurred'`), detailed errors to server logs
- Never expose stack traces, internal paths, or SQL errors to the client
- Use `code` field for machine-readable error classification when needed
