---
name: supabase-rls-auth
description: Supabase Row Level Security patterns and auth verification. RLS policy design, auth.uid() optimization, getUser vs getSession, security defaults.
axis: domain
origin: ECC-PSDE
---

# Supabase RLS and Authentication

Row Level Security patterns and auth verification for Supabase projects. Framework-agnostic -- client initialization and token refresh are Environment concerns.

## When to Activate

- Enabling RLS on tables
- Writing RLS policies
- Verifying user identity via Supabase Auth
- Configuring least-privilege access

## RLS Policies

### Enable RLS on Every User-Facing Table

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
```

### Wrap auth.uid() in SELECT

Per-row function calls are expensive. Wrapping in a subselect lets Postgres evaluate once:

```sql
-- GOOD: Evaluated once per query
CREATE POLICY "Users see own projects"
  ON projects FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

-- BAD: Evaluated per row
CREATE POLICY "Users see own projects"
  ON projects FOR SELECT
  USING (auth.uid() = user_id);
```

### Always Index RLS Policy Columns

```sql
-- The column referenced in USING must be indexed
CREATE INDEX idx_projects_user_id ON projects (user_id);
```

### Multi-Operation Policies

```sql
CREATE POLICY "Users manage own data"
  ON projects FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
```

## Auth Verification

### getUser() vs getSession()

```typescript
// CRITICAL: Use getUser() for auth verification.
const { data: { user } } = await supabase.auth.getUser()

// getUser() makes a round-trip to Supabase Auth to confirm validity.
// getSession() only reads from the JWT without server-side validation.
// Never trust getSession() alone for authorization decisions.
```

### Anon Key vs Service Role Key

- **Anon key**: safe for client-side use. RLS enforces access control.
- **Service role key**: bypasses RLS entirely. Server-only, never expose to client.
- Always use the anon key + user JWT in application code. Reserve the service role key for admin scripts, migrations, and server-side operations that intentionally bypass RLS.

## Security Defaults

```sql
-- Revoke default public schema access
REVOKE ALL ON SCHEMA public FROM public;
```

- Never bypass RLS in application code
- Never grant ALL to application-level database users
- RLS policies should reference indexed columns only

## What This Skill Does NOT Cover

Client initialization (`createServerClient`, `createBrowserClient`), token refresh middleware, and cookie configuration are framework-specific (Next.js, Vite, etc.) and belong in an **Environment** skill for your deployment target.
