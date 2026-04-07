import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDrizzleTestApp, type DrizzleTestContext } from './drizzle-test-helper.js';
import { ingestTaskFile, ingestTaskDir } from './task-ingest.js';
import { tasks } from './schema/tables.js';
import { eq } from 'drizzle-orm';
import { taskFiles } from './schema/tables.js';

describe('ingestTaskFile', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('happy path: parses all frontmatter fields', async () => {
    const content = [
      '---',
      'title: Build the widget',
      'priority: 5',
      'acceptance_criteria: Widget compiles and passes tests',
      'files:',
      '  - src/Widget.cpp',
      '  - src/Widget.h',
      '---',
      'This is the task description.',
      '',
      'It has multiple lines.',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/build-widget.md', content, 'default');

    assert.equal(result.action, 'created');
    assert.equal(typeof result.taskId, 'number');

    // Verify inserted task
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Build the widget');
    assert.equal(rows[0].priority, 5);
    assert.equal(rows[0].basePriority, 5);
    assert.equal(rows[0].acceptanceCriteria, 'Widget compiles and passes tests');
    assert.equal(rows[0].sourcePath, '/tasks/build-widget.md');
    assert.ok(rows[0].description!.includes('This is the task description.'));
    assert.ok(rows[0].description!.includes('It has multiple lines.'));

    // Verify files linked
    const fileRows = await ctx.db.select().from(taskFiles).where(eq(taskFiles.taskId, result.taskId));
    assert.equal(fileRows.length, 2);
    const paths = fileRows.map((r) => r.filePath).sort();
    assert.deepEqual(paths, ['src/Widget.cpp', 'src/Widget.h']);
  });

  it('title falls back to filename when frontmatter has no title', async () => {
    const content = [
      '---',
      'priority: 3',
      '---',
      'Some description.',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/my-cool-task.md', content, 'default');

    assert.equal(result.action, 'created');
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    assert.equal(rows[0].title, 'my cool task');
  });

  it('priority defaults to 0 for non-integer values', async () => {
    const content = [
      '---',
      'title: Bad priority task',
      'priority: not-a-number',
      '---',
      'Body.',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/bad-priority.md', content, 'default');

    assert.equal(result.action, 'created');
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    assert.equal(rows[0].priority, 0);
  });

  it('priority defaults to 0 for float values', async () => {
    const content = [
      '---',
      'title: Float priority task',
      'priority: 3.7',
      '---',
      'Body.',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/float-priority.md', content, 'default');

    assert.equal(result.action, 'created');
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    assert.equal(rows[0].priority, 0);
  });

  it('files list parsed from frontmatter', async () => {
    const content = [
      '---',
      'title: Files task',
      'files:',
      '  - Source/Module/Foo.cpp',
      '  - Source/Module/Foo.h',
      '  - Source/Module/Bar.cpp',
      '---',
      'Task with files.',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/files-task.md', content, 'default');

    const fileRows = await ctx.db.select().from(taskFiles).where(eq(taskFiles.taskId, result.taskId));
    assert.equal(fileRows.length, 3);
  });

  it('dedup on re-ingest: same sourcePath returns skipped', async () => {
    const content = [
      '---',
      'title: Duplicate task',
      '---',
      'Body.',
    ].join('\n');

    const first = await ingestTaskFile(ctx.db, '/tasks/dup.md', content, 'default');
    assert.equal(first.action, 'created');

    const second = await ingestTaskFile(ctx.db, '/tasks/dup.md', content, 'default');
    assert.equal(second.action, 'skipped');
    assert.equal(second.taskId, first.taskId);
  });

  it('malformed frontmatter (no --- delimiters) treats entire content as description', async () => {
    const content = 'This is just a plain markdown file with no frontmatter.';

    const result = await ingestTaskFile(ctx.db, '/tasks/no-frontmatter.md', content, 'default');

    assert.equal(result.action, 'created');
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    // Title falls back to filename
    assert.equal(rows[0].title, 'no frontmatter');
    // Body is the entire content
    assert.ok(rows[0].description!.includes('This is just a plain markdown file'));
  });

  it('different projectId does not dedup', async () => {
    const content = [
      '---',
      'title: Cross-project task',
      '---',
      'Body.',
    ].join('\n');

    const first = await ingestTaskFile(ctx.db, '/tasks/cross.md', content, 'project-a');
    assert.equal(first.action, 'created');

    const second = await ingestTaskFile(ctx.db, '/tasks/cross.md', content, 'project-b');
    assert.equal(second.action, 'created');
    assert.notEqual(second.taskId, first.taskId);
  });

  it('invalid YAML syntax falls back to filename-derived title', async () => {
    const content = [
      '---',
      'title: [invalid yaml',
      '  broken: {unclosed',
      '---',
      'Body content',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/broken-yaml.md', content, 'default');

    assert.equal(result.action, 'created');
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    assert.equal(rows.length, 1);
    // Title falls back to filename because YAML parse failed
    assert.equal(rows[0].title, 'broken yaml');
    // Full content (including the broken frontmatter) becomes description
    assert.ok(rows[0].description!.includes('Body content'));
  });

  it('priority defaults to 0 when not specified', async () => {
    const content = [
      '---',
      'title: No priority',
      '---',
      'Body.',
    ].join('\n');

    const result = await ingestTaskFile(ctx.db, '/tasks/no-priority.md', content, 'default');
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    assert.equal(rows[0].priority, 0);
  });
});

describe('ingestTaskDir', () => {
  let ctx: DrizzleTestContext;
  let tmpDir: string;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    tmpDir = await mkdtemp(join(tmpdir(), 'ingest-dir-test-'));
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('ingests .md files, skips non-.md files', async () => {
    // File with frontmatter
    await writeFile(join(tmpDir, 'task-one.md'), [
      '---',
      'title: Task One',
      'priority: 3',
      '---',
      'Description for task one.',
    ].join('\n'));

    // File without frontmatter
    await writeFile(join(tmpDir, 'task-two.md'), 'Plain markdown with no frontmatter.');

    // Non-.md file that should be filtered out
    await writeFile(join(tmpDir, 'notes.txt'), 'This should be ignored.');

    const result = await ingestTaskDir(ctx.db, tmpDir, 'default');

    assert.equal(result.ingested, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.tasks.length, 2);

    // Verify both .md files were processed
    const actions = result.tasks.map((t) => t.action);
    assert.ok(actions.every((a) => a === 'created'));

    // Verify the non-.md file was excluded
    const files = result.tasks.map((t) => t.file);
    assert.ok(!files.includes('notes.txt'));
  });

  it('dedup on re-ingest returns skipped for existing tasks', async () => {
    await writeFile(join(tmpDir, 'repeat.md'), [
      '---',
      'title: Repeat Task',
      '---',
      'Body.',
    ].join('\n'));

    const first = await ingestTaskDir(ctx.db, tmpDir, 'default');
    assert.equal(first.ingested, 1);

    const second = await ingestTaskDir(ctx.db, tmpDir, 'default');
    assert.equal(second.ingested, 0);
    assert.equal(second.skipped, 1);
  });
});
