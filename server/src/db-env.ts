/**
 * Resolve the scaffold's own database URL, immune to inherited DATABASE_URL.
 *
 * Reads SCAFFOLD_DATABASE_URL. If set, copies it onto process.env.DATABASE_URL
 * (so the existing drizzle-instance factory branch fires). If unset, deletes
 * any inherited DATABASE_URL so the factory falls back to PGlite.
 *
 * This indirection exists because the user's shell may inherit DATABASE_URL
 * from an unrelated co-installed Supabase project, which would silently route
 * the scaffold server at the wrong database.
 *
 * Must be called once, before initDrizzle(), at process start.
 */
export function applyScaffoldDatabaseUrl(): {
  backendHint: "postgres" | "pglite";
} {
  const scaffoldUrl = process.env.SCAFFOLD_DATABASE_URL;
  if (scaffoldUrl && scaffoldUrl.length > 0) {
    process.env.DATABASE_URL = scaffoldUrl;
    return { backendHint: "postgres" };
  }
  delete process.env.DATABASE_URL;
  return { backendHint: "pglite" };
}
