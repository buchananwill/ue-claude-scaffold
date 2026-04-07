/**
 * Server-side task ingestion from markdown files with frontmatter.
 *
 * Replaces the shell-based parse_frontmatter / ingest loop from
 * scripts/ingest-tasks.sh with a TypeScript implementation using gray-matter.
 */
import matter from 'gray-matter';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { tasks } from './schema/tables.js';
import * as tasksCore from './queries/tasks-core.js';
import { linkFilesToTask } from './queries/composition.js';
import { runReplan } from './routes/tasks-replan.js';
import type { DrizzleDb } from './drizzle-instance.js';

export interface IngestFileResult {
  action: 'created' | 'skipped';
  taskId: number;
}

export interface IngestDirResult {
  ingested: number;
  skipped: number;
  errors: number;
  replanned: number;
  tasks: Array<{ file: string; action: 'created' | 'skipped' | 'error'; taskId?: number; error?: string }>;
}

/**
 * Ingest a single markdown task file.
 *
 * Uses gray-matter to parse YAML frontmatter. Extracts title (falls back to
 * filename), priority (default 0, must be integer), acceptance_criteria,
 * files (array of file paths). Body after frontmatter becomes description.
 * Deduplicates against existing tasks by sourcePath.
 *
 * @param filePath - Used as the dedup key (stored as `sourcePath` in the DB).
 *   Should be a consistent, canonical absolute path for dedup to work correctly
 *   across invocations. Note this is a host-specific path — dedup only works
 *   within a single host where paths are stable.
 */
export async function ingestTaskFile(
  db: DrizzleDb,
  filePath: string,
  fileContent: string,
  projectId: string,
): Promise<IngestFileResult> {
  // Check for existing task with same sourcePath + projectId
  const existing = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.sourcePath, filePath), eq(tasks.projectId, projectId)));

  if (existing.length > 0) {
    return { action: 'skipped', taskId: existing[0].id };
  }

  // Parse frontmatter — wrap in try/catch because gray-matter throws
  // YAMLException on structurally invalid YAML within frontmatter delimiters.
  let data: Record<string, unknown> = {};
  let body: string;
  try {
    const parsed = matter(fileContent);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content.trim();
  } catch {
    // Fall back to treating the entire content as description, derive title from filename
    data = {};
    body = fileContent.trim();
  }

  // Title: frontmatter or fall back to filename
  const title = typeof data.title === 'string' && data.title.length > 0
    ? data.title
    : basename(filePath, '.md').replace(/[-_]/g, ' ');

  // Priority: must be integer, default 0
  const priority = (() => {
    if (data.priority !== undefined) {
      const numericPriority = Number(data.priority);
      if (Number.isInteger(numericPriority)) {
        return numericPriority;
      }
    }
    return 0;
  })();

  // Acceptance criteria
  const acceptanceCriteria = typeof data.acceptance_criteria === 'string'
    ? data.acceptance_criteria
    : undefined;

  // Files list
  const filesList: string[] = [];
  if (Array.isArray(data.files)) {
    for (const f of data.files) {
      if (typeof f === 'string' && f.length > 0) {
        filesList.push(f);
      }
    }
  }

  // Insert the task
  const row = await tasksCore.insert(db, {
    title,
    description: body,
    sourcePath: filePath,
    acceptanceCriteria,
    priority,
    projectId,
  });

  // Link files if any
  if (filesList.length > 0) {
    await linkFilesToTask(db, row.id, filesList, projectId);
  }

  return { action: 'created', taskId: row.id };
}

/**
 * Ingest all .md files in a directory.
 *
 * Reads each file, calls ingestTaskFile, then runs replan.
 */
export async function ingestTaskDir(
  db: DrizzleDb,
  dirPath: string,
  projectId: string,
): Promise<IngestDirResult> {
  const entries = await readdir(dirPath);
  const mdFiles = entries.filter((e) => e.endsWith('.md')).sort();

  const results: IngestDirResult['tasks'] = [];
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  // Sequential execution is intentional — avoids concurrent PGlite write contention.
  for (const file of mdFiles) {
    try {
      const fullPath = join(dirPath, file);
      const content = await readFile(fullPath, 'utf-8');
      const result = await ingestTaskFile(db, fullPath, content, projectId);

      results.push({ file, action: result.action, taskId: result.taskId });

      if (result.action === 'created') {
        ingested++;
      } else {
        skipped++;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = code ? `File error: ${code}` : 'Failed to process file';
      results.push({ file, action: 'error' as const, error: message });
      errors++;
    }
  }

  // Replan is a global operation by design — it operates on the full task
  // dependency graph across all projects, not just the project being ingested.
  // The replanned count in the response is the global count.
  let replanned = 0;
  if (ingested > 0) {
    const replanResult = await runReplan();
    replanned = replanResult.replanned;
  }

  return { ingested, skipped, errors, replanned, tasks: results };
}
