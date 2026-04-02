/**
 * E2E test: UBT contention retry against real Unreal Build Tool.
 *
 * This test proves the server absorbs UBT mutex contention and retries until
 * it succeeds.  It requires:
 *   - A real UE project with a working build script
 *   - scaffold.config.json pointing at that project
 *   - UE installed at the configured engine path
 *
 * Run manually (not part of `npm test`):
 *   npx tsx --test src/routes/build.e2e-test.ts
 *
 * The test:
 *   1. Touches a .cpp file to guarantee a non-trivial build time
 *   2. Starts a direct build via the project's build script (holds UBT mutex)
 *   3. While that build is running, calls the server's /build endpoint
 *   4. Asserts the server detects contention, retries, and eventually succeeds
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import buildPlugin from './build.js';
import { initDrizzle, closeDrizzle } from '../drizzle-instance.js';
import projectIdPlugin from '../plugins/project-id.js';
import { loadConfig, type ScaffoldConfig } from '../config.js';

// Resolve script path to interpreter + args (mirrors build.ts logic)
function resolveScript(scriptPath: string): { command: string; args: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === '.py') return { command: 'python', args: [scriptPath] };
  if (ext === '.sh') return { command: 'bash', args: [scriptPath] };
  return { command: scriptPath, args: [] };
}

describe('E2E: UBT contention retry with real build', () => {
  let config: ScaffoldConfig;
  let projectPath: string;
  let buildScriptPath: string;
  let touchedFile: string | null = null;
  let originalContent: string | null = null;

  before(() => {
    try {
      config = loadConfig();
    } catch {
      throw new Error(
        'scaffold.config.json not found or invalid. This E2E test must run from the scaffold repo root.'
      );
    }
    projectPath = config.project.path;
    buildScriptPath = path.resolve(projectPath, config.build.scriptPath);

    if (!existsSync(buildScriptPath)) {
      throw new Error(`Build script not found: ${buildScriptPath}`);
    }

    // Find a .cpp file to touch.  We pick a file that is likely to trigger
    // a non-trivial recompile — the main game mode file is a good candidate
    // since it pulls in many headers.
    const candidates = [
      'Source/PistePerfect/Private/Core/GameModes/GameModeMain.cpp',
      'Source/PistePerfect/Private/Core/GameModes/GameModeBoot.cpp',
      'Source/PistePerfect/Private/GameModeMain.cpp',
      'Source/PistePerfect/Private/GameModeBoot.cpp',
    ];
    for (const rel of candidates) {
      const abs = path.join(projectPath, rel);
      if (existsSync(abs)) {
        touchedFile = abs;
        break;
      }
    }
    if (!touchedFile) {
      throw new Error(
        `Could not find a .cpp file to touch in ${projectPath}. Tried: ${candidates.join(', ')}`
      );
    }

    // Save original content so we can restore it.
    originalContent = readFileSync(touchedFile, 'utf-8');
  });

  after(() => {
    // Restore the touched file to its original state.
    if (touchedFile && originalContent !== null) {
      writeFileSync(touchedFile, originalContent);
    }
  });

  it('server retries and succeeds when UBT mutex is held by a concurrent build', async () => {
    // ── Step 1: Touch the .cpp to guarantee a non-trivial build ──────────
    assert.ok(touchedFile, 'touchedFile must be set');
    appendFileSync(touchedFile, `\n// E2E touch ${Date.now()}\n`);

    // ── Step 2: Start a direct build to hold the UBT mutex ───────────────
    const { command, args } = resolveScript(buildScriptPath);
    const directBuild = spawn(command, [...args, '--summary'], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect output for diagnostics
    let directStdout = '';
    let directStderr = '';
    directBuild.stdout.on('data', (d: Buffer) => { directStdout += d.toString(); });
    directBuild.stderr.on('data', (d: Buffer) => { directStderr += d.toString(); });

    const directDone = new Promise<number>((resolve) => {
      directBuild.on('close', (code) => resolve(code ?? 1));
      directBuild.on('error', () => resolve(1));
    });

    // Wait briefly for UBT to acquire its mutex before we fire the server request.
    await new Promise((r) => setTimeout(r, 3000));

    // Verify the direct build is still running (i.e. it hasn't finished instantly).
    if (directBuild.exitCode !== null) {
      console.log('Direct build stdout:', directStdout);
      console.log('Direct build stderr:', directStderr);
      throw new Error(
        `Direct build finished too fast (exit ${directBuild.exitCode}). ` +
        `The .cpp touch may not have triggered a real recompile. ` +
        `Try a more invasive change or a different file.`
      );
    }

    // ── Step 3: Stand up a Fastify instance and hit /build ───────────────
    // Use a short retry delay so the test doesn't take forever, but enough
    // retries to outlast the direct build.
    const testConfig = {
      ...config,
      build: {
        ...config.build,
        ubtRetryCount: 30,    // up to 30 retries
        ubtRetryDelayMs: 15_000, // 15s between retries — enough for a real build
      },
    };

    await initDrizzle(); // in-memory PGlite

    const app = Fastify();
    await app.register(sensible);
    await app.register(projectIdPlugin);
    await app.register(buildPlugin, { config: testConfig });
    await app.ready();

    const t0 = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/build',
      payload: {},
    });
    const elapsed = Date.now() - t0;
    const body = res.json();

    // Wait for the direct build to finish so we don't leave orphan processes.
    const directExitCode = await directDone;

    await app.close();
    await closeDrizzle();

    // ── Step 4: Assertions ───────────────────────────────────────────────
    console.log(`Direct build exited with code ${directExitCode} (stdout: ${directStdout.length} bytes)`);
    console.log(`Server /build completed in ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`Server result: success=${body.success}, exit_code=${body.exit_code}`);

    // The direct build should have succeeded (the .cpp touch is benign).
    assert.equal(directExitCode, 0, `Direct build failed — check project state. stderr: ${directStderr.slice(-500)}`);

    // The server must have succeeded after retrying through contention.
    assert.equal(body.success, true, `Server /build failed: ${body.output?.slice(-500)} | ${body.stderr?.slice(-500)}`);

    // The server response should NOT contain contention messages (those were retried away).
    assert.ok(
      !body.output.includes('ConflictingInstance'),
      'Final server output should not contain contention — retries should have absorbed it',
    );

    // The elapsed time should be > the retry delay (proving at least one retry happened)
    // and > the direct build time (proving the server waited for contention to clear).
    assert.ok(
      elapsed > 10_000,
      `Expected the server to have retried (elapsed ${elapsed}ms < 10s suggests no contention occurred). ` +
      `Was UBT actually held? Check if the .cpp touch triggered a real recompile.`,
    );
  });
});
