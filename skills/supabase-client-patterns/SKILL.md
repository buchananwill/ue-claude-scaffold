---
name: supabase-client-patterns
description: Supabase JS client query patterns, repository pattern, N+1 prevention, transactions via RPC, and upserts.
axis: domain
origin: ECC-PSDE
---

# Supabase Client Patterns

Query patterns and data access for the Supabase JavaScript client.

## When to Activate

- Writing Supabase queries in TypeScript
- Implementing data access layers
- Optimizing query performance
- Handling transactions

## Query Fundamentals

### Always Select Explicit Columns

```typescript
// GOOD: Select only needed columns
const { data } = await supabase
  .from('projects')
  .select('id, name, status, created_at')
  .eq('status', 'active')
  .order('created_at', { ascending: false })
  .limit(20)

// BAD: Select everything
const { data } = await supabase
  .from('projects')
  .select('*')
```

### Always Include .limit()

All user-facing queries must include `.limit()` to prevent unbounded results.

## Repository Pattern

```typescript
interface ProjectRepository {
  findAll(filters?: ProjectFilters): Promise<Project[]>
  findById(id: string): Promise<Project | null>
  create(data: CreateProjectDto): Promise<Project>
}

class SupabaseProjectRepository implements ProjectRepository {
  constructor(private supabase: SupabaseClient) {}

  async findAll(filters?: ProjectFilters): Promise<Project[]> {
    let query = this.supabase
      .from('projects')
      .select('id, name, status, created_at')

    if (filters?.status) {
      query = query.eq('status', filters.status)
    }

    const { data, error } = await query.limit(filters?.limit ?? 50)
    if (error) throw new Error(error.message)
    return data
  }
}
```

## N+1 Prevention

```typescript
// BAD: N+1 queries
const projects = await getProjects()
for (const project of projects) {
  project.owner = await getUser(project.owner_id)  // N queries
}

// GOOD: Batch fetch
const projects = await getProjects()
const ownerIds = [...new Set(projects.map(p => p.owner_id))]
const { data: owners } = await supabase
  .from('users')
  .select('id, name, email')
  .in('id', ownerIds)

const ownerMap = new Map(owners.map(o => [o.id, o]))
projects.forEach(p => { p.owner = ownerMap.get(p.owner_id) })
```

## Transactions via RPC

Supabase JS client has no built-in transaction support. Use Postgres functions:

```typescript
const { data, error } = await supabase.rpc('create_project_with_member', {
  project_data: projectData,
  member_data: memberData,
})
```

```sql
CREATE OR REPLACE FUNCTION create_project_with_member(
  project_data jsonb,
  member_data jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO projects VALUES (project_data);
  INSERT INTO members VALUES (member_data);
  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
```

## Upsert

```typescript
const { data } = await supabase
  .from('settings')
  .upsert(
    { user_id: userId, key: 'theme', value: 'dark' },
    { onConflict: 'user_id,key' }
  )
```

## Cursor Pagination

```typescript
// GOOD: O(1) cursor pagination
const { data } = await supabase
  .from('projects')
  .select('id, name, created_at')
  .gt('id', lastId)
  .order('id')
  .limit(20)

// BAD: O(n) offset pagination
const { data } = await supabase
  .from('projects')
  .select('*')
  .range(offset, offset + limit)
```
