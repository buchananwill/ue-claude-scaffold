import { lstatSync, existsSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ScaffoldConfig } from './config.js';

interface CopyResult {
  plugin: string;
  action: 'copied' | 'skipped' | 'replaced_junction';
  durationMs?: number;
}

function runCopy(source: string, dest: string, timeoutMs: number): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    // robocopy: /E = include subdirs, /XD = exclude dirs, /XO = skip older files
    // /NFL /NDL /NJH /NJS /NP = suppress noisy per-file output
    // robocopy exit codes: 0 = no files copied, 1 = files copied, 2-7 = various success with extras
    // >=8 = error
    const child = spawn('robocopy', [
      source, dest,
      '/E',
      '/XD', 'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache',
      '/XO',
      '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
      '/R:1', '/W:1',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));

    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf-8').trim();
      // robocopy uses non-standard exit codes: 0-7 = success, >=8 = error
      resolve({ success: (code ?? 8) < 8, output });
    });

    child.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

function isJunctionOrSymlink(p: string): boolean {
  try {
    const stat = lstatSync(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Ensure each configured plugin exists as a real directory (not a junction/symlink)
 * in the staging worktree. Junctions are removed and replaced with a physical copy.
 * Existing real directories are left alone to preserve UBT intermediate caches.
 *
 * Source files are copied excluding Intermediate/, Binaries/, Saved/, and
 * DerivedDataCache/ so each worktree builds its own artifacts independently.
 */
export async function ensureStagingPlugins(
  worktreePath: string,
  config: ScaffoldConfig,
): Promise<CopyResult[]> {
  const copies = config.plugins?.stagingCopies;
  if (!copies || copies.length === 0) return [];

  const results: CopyResult[] = [];

  for (const entry of copies) {
    const dest = path.join(worktreePath, entry.relativeDest);
    const pluginName = path.basename(entry.relativeDest);

    // Source must exist
    if (!existsSync(entry.source)) {
      console.log(`[staging-plugins] Source not found, skipping: ${entry.source}`);
      results.push({ plugin: pluginName, action: 'skipped' });
      continue;
    }

    // If dest is a junction/symlink, remove it (rmdir removes junction without deleting target)
    if (isJunctionOrSymlink(dest)) {
      console.log(`[staging-plugins] Removing junction at ${dest}`);
      rmdirSync(dest);
      // After removing the junction, fall through to copy
    }

    // If dest already exists as a real directory, skip — preserves build cache
    if (existsSync(dest)) {
      results.push({ plugin: pluginName, action: 'skipped' });
      continue;
    }

    // Copy source → dest
    console.log(`[staging-plugins] Copying ${entry.source} → ${dest}`);
    const t0 = Date.now();
    const { success, output } = await runCopy(entry.source, dest, 120_000);
    const durationMs = Date.now() - t0;

    if (!success) {
      console.error(`[staging-plugins] Copy failed for ${pluginName}: ${output}`);
      results.push({ plugin: pluginName, action: 'skipped', durationMs });
      continue;
    }

    console.log(`[staging-plugins] Copied ${pluginName} in ${durationMs}ms`);
    results.push({
      plugin: pluginName,
      action: isJunctionOrSymlink(dest) ? 'replaced_junction' : 'copied',
      durationMs,
    });
  }

  return results;
}

/**
 * Refresh plugin source files in an existing staging worktree copy.
 * Unlike ensureStagingPlugins, this re-copies source files even if the
 * destination already exists (but still preserves Intermediate/Binaries).
 * Use when upstream plugin source has changed (e.g., after git pull on Voxel repo).
 */
export async function refreshStagingPlugins(
  worktreePath: string,
  config: ScaffoldConfig,
): Promise<CopyResult[]> {
  const copies = config.plugins?.stagingCopies;
  if (!copies || copies.length === 0) return [];

  const results: CopyResult[] = [];

  for (const entry of copies) {
    const dest = path.join(worktreePath, entry.relativeDest);
    const pluginName = path.basename(entry.relativeDest);

    if (!existsSync(entry.source)) {
      results.push({ plugin: pluginName, action: 'skipped' });
      continue;
    }

    // Remove junction if present
    if (isJunctionOrSymlink(dest)) {
      rmdirSync(dest);
    }

    const t0 = Date.now();
    const { success, output } = await runCopy(entry.source, dest, 120_000);
    const durationMs = Date.now() - t0;

    if (!success) {
      console.error(`[staging-plugins] Refresh failed for ${pluginName}: ${output}`);
      results.push({ plugin: pluginName, action: 'skipped', durationMs });
    } else {
      console.log(`[staging-plugins] Refreshed ${pluginName} in ${durationMs}ms`);
      results.push({ plugin: pluginName, action: 'copied', durationMs });
    }
  }

  return results;
}
