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
  replanned: number;
  tasks: Array<{ file: string; action: 'created' | 'skipped'; taskId: number }>;
}

/**
 * Ingest a single markdown task file.
 *
 * Uses gray-matter to parse YAML frontmatter. Extracts title (falls back to
 * filename), priority (default 0, must be integer), acceptance_criteria,
 * files (array of file paths). Body after frontmatter becomes description.
 * Deduplicates against existing tasks by sourcePath.
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

  // Parse frontmatter
  const parsed = matter(fileContent);
  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  // Title: frontmatter or fall back to filename
  let title = typeof data.title === 'string' && data.title.length > 0
    ? data.title
    : basename(filePath, '.md').replace(/[-_]/g, ' ');

  // Priority: must be integer, default 0
  let priority = 0;
  if (data.priority !== undefined) {
    const parsed = Number(data.priority);
    if (Number.isInteger(parsed)) {
      priority = parsed;
    }
  }

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

  for (const file of mdFiles) {
    const fullPath = join(dirPath, file);
    const content = await readFile(fullPath, 'utf-8');
    const result = await ingestTaskFile(db, fullPath, content, projectId);

    results.push({ file, action: result.action, taskId: result.taskId });

    if (result.action === 'created') {
      ingested++;
    } else {
      skipped++;
    }
  }

  // Run replan after ingestion
  let replanned = 0;
  if (ingested > 0) {
    const replanResult = await runReplan();
    replanned = replanResult.replanned;
  }

  return { ingested, skipped, replanned, tasks: results };
}
