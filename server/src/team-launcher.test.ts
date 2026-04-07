import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createTestDb } from './queries/test-utils.js';
import { launchTeam, loadTeamDef, validateBriefOnSeedBranch } from './team-launcher.js';
import type { MergedProjectConfig } from './config.js';
import type { DrizzleDb } from './drizzle-instance.js';
import * as teamsQ from './queries/teams.js';
import * as chatQ from './queries/chat.js';

/**
 * Helper: create a bare repo with a seed branch containing the given files.
 */
function createTestBareRepo(projectId: string, files: Record<string, string> = {}): string {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'team-launcher-test-'));
  const workDir = path.join(tmpDir, 'work');
  const bareDir = path.join(tmpDir, 'bare.git');

  mkdirSync(workDir, { recursive: true });
  execSync('git init', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });

  // Create files
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(workDir, filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // Commit
  execSync('git add -A', { cwd: workDir, stdio: 'pipe' });
  execSync('git commit -m "init" --allow-empty', { cwd: workDir, stdio: 'pipe' });

  // Create bare clone
  execSync(`git clone --bare "${workDir}" "${bareDir}"`, { stdio: 'pipe' });

  // Create seed branch
  const sha = execSync('git rev-parse HEAD', { cwd: bareDir, encoding: 'utf-8' }).trim();
  execSync(`git update-ref refs/heads/docker/${projectId}/current-root ${sha}`, {
    cwd: bareDir,
    stdio: 'pipe',
  });

  return bareDir;
}

/**
 * Helper: create a teams directory with a definition file.
 */
function createTeamsDir(teamId: string, def: object): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-'));
  writeFileSync(path.join(dir, `${teamId}.json`), JSON.stringify(def, null, 2));
  return dir;
}

describe('validateBriefOnSeedBranch', () => {
  let bareDir: string;

  beforeEach(() => {
    bareDir = createTestBareRepo('test-proj', { 'plans/brief.md': '# Brief' });
  });

  afterEach(() => {
    rmSync(path.dirname(bareDir), { recursive: true, force: true });
  });

  it('does not throw when brief exists', () => {
    assert.doesNotThrow(() => {
      validateBriefOnSeedBranch(bareDir, 'test-proj', 'plans/brief.md');
    });
  });

  it('throws when brief does not exist', () => {
    assert.throws(
      () => validateBriefOnSeedBranch(bareDir, 'test-proj', 'plans/nonexistent.md'),
      /Brief not found/,
    );
  });
});

describe('loadTeamDef', () => {
  it('loads a valid team definition', () => {
    const dir = createTeamsDir('test-team', {
      id: 'test-team',
      name: 'Test Team',
      members: [
        { agentName: 'leader', role: 'lead', agentType: 'orchestrator', isLeader: true },
        { agentName: 'worker', role: 'impl', agentType: 'implementer' },
      ],
    });
    const def = loadTeamDef(dir, 'test-team');
    assert.equal(def.id, 'test-team');
    assert.equal(def.members.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when team file does not exist', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-'));
    assert.throws(
      () => loadTeamDef(dir, 'nonexistent'),
      /Team definition not found/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws on duplicate member names', () => {
    const dir = createTeamsDir('dup-team', {
      id: 'dup-team',
      name: 'Dup Team',
      members: [
        { agentName: 'agent-1', role: 'lead', agentType: 'orchestrator', isLeader: true },
        { agentName: 'agent-1', role: 'impl', agentType: 'implementer' },
      ],
    });
    assert.throws(
      () => loadTeamDef(dir, 'dup-team'),
      /Duplicate member agentName/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when no leader is present', () => {
    const dir = createTeamsDir('no-leader', {
      id: 'no-leader',
      name: 'No Leader',
      members: [
        { agentName: 'a', role: 'impl', agentType: 'implementer' },
      ],
    });
    assert.throws(
      () => loadTeamDef(dir, 'no-leader'),
      /Exactly one discussion leader/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('launchTeam', () => {
  let bareDir: string;
  let testDb: { db: DrizzleDb; close: () => Promise<void> };

  beforeEach(async () => {
    bareDir = createTestBareRepo('test-proj', { 'plans/brief.md': '# Brief' });
    testDb = await createTestDb();
  });

  afterEach(async () => {
    rmSync(path.dirname(bareDir), { recursive: true, force: true });
    await testDb.close();
  });

  it('happy path: registers team, posts brief, sets branches, returns plan', async () => {
    const teamsDir = createTeamsDir('my-team', {
      id: 'my-team',
      name: 'My Team',
      members: [
        { agentName: 'leader-1', role: 'lead', agentType: 'orchestrator', isLeader: true },
        { agentName: 'worker-1', role: 'impl', agentType: 'implementer', isLeader: false },
      ],
    });

    const project: MergedProjectConfig = {
      name: 'Test',
      path: '/tmp/test',
      bareRepoPath: bareDir,
    };

    const result = await launchTeam({
      projectId: 'test-proj',
      teamId: 'my-team',
      briefPath: 'plans/brief.md',
      teamsDir,
      project,
      db: testDb.db,
    });

    // Check result shape
    assert.equal(result.roomId, 'my-team');
    assert.equal(result.members.length, 2);

    // Leader should be first
    assert.equal(result.members[0].agentName, 'leader-1');
    assert.equal(result.members[0].isLeader, true);
    assert.equal(result.members[0].agentType, 'orchestrator');
    assert.equal(result.members[0].branch, 'docker/test-proj/leader-1');

    assert.equal(result.members[1].agentName, 'worker-1');
    assert.equal(result.members[1].isLeader, false);
    assert.equal(result.members[1].branch, 'docker/test-proj/worker-1');

    // Verify team was registered in DB
    const team = await teamsQ.getById(testDb.db, 'my-team');
    assert.ok(team);
    assert.equal(team.name, 'My Team');
    assert.equal(team.briefPath, 'plans/brief.md');

    // Verify brief was posted to room
    const messages = await chatQ.getHistory(testDb.db, 'my-team', { limit: 10 });
    assert.equal(messages.length, 1);
    assert.ok(messages[0].content.includes('plans/brief.md'));

    // Verify branches exist in bare repo
    const leaderRef = execSync(
      `git rev-parse --verify refs/heads/docker/test-proj/leader-1`,
      { cwd: bareDir, encoding: 'utf-8' },
    ).trim();
    assert.ok(leaderRef.length > 0);

    const workerRef = execSync(
      `git rev-parse --verify refs/heads/docker/test-proj/worker-1`,
      { cwd: bareDir, encoding: 'utf-8' },
    ).trim();
    assert.ok(workerRef.length > 0);

    rmSync(teamsDir, { recursive: true, force: true });
  });

  it('throws on missing brief', async () => {
    const teamsDir = createTeamsDir('brief-team', {
      id: 'brief-team',
      name: 'Brief Team',
      members: [
        { agentName: 'a', role: 'lead', agentType: 'orchestrator', isLeader: true },
      ],
    });

    const project: MergedProjectConfig = {
      name: 'Test',
      path: '/tmp/test',
      bareRepoPath: bareDir,
    };

    await assert.rejects(
      () => launchTeam({
        projectId: 'test-proj',
        teamId: 'brief-team',
        briefPath: 'plans/nonexistent.md',
        teamsDir,
        project,
        db: testDb.db,
      }),
      /Brief not found/,
    );

    rmSync(teamsDir, { recursive: true, force: true });
  });

  it('throws on missing team file', async () => {
    const teamsDir = mkdtempSync(path.join(os.tmpdir(), 'teams-'));

    const project: MergedProjectConfig = {
      name: 'Test',
      path: '/tmp/test',
      bareRepoPath: bareDir,
    };

    await assert.rejects(
      () => launchTeam({
        projectId: 'test-proj',
        teamId: 'nonexistent',
        briefPath: 'plans/brief.md',
        teamsDir,
        project,
        db: testDb.db,
      }),
      /Team definition not found/,
    );

    rmSync(teamsDir, { recursive: true, force: true });
  });

  it('throws on duplicate member names in team def', async () => {
    const teamsDir = createTeamsDir('dup-team', {
      id: 'dup-team',
      name: 'Dup Team',
      members: [
        { agentName: 'same-name', role: 'lead', agentType: 'orchestrator', isLeader: true },
        { agentName: 'same-name', role: 'impl', agentType: 'implementer' },
      ],
    });

    const project: MergedProjectConfig = {
      name: 'Test',
      path: '/tmp/test',
      bareRepoPath: bareDir,
    };

    await assert.rejects(
      () => launchTeam({
        projectId: 'test-proj',
        teamId: 'dup-team',
        briefPath: 'plans/brief.md',
        teamsDir,
        project,
        db: testDb.db,
      }),
      /Duplicate member agentName/,
    );

    rmSync(teamsDir, { recursive: true, force: true });
  });

  it('re-launches a dissolved team successfully', async () => {
    const teamsDir = createTeamsDir('relaunch-team', {
      id: 'relaunch-team',
      name: 'Relaunch Team',
      members: [
        { agentName: 'leader-r', role: 'lead', agentType: 'orchestrator', isLeader: true },
        { agentName: 'worker-r', role: 'impl', agentType: 'implementer', isLeader: false },
      ],
    });

    const project: MergedProjectConfig = {
      name: 'Test',
      path: '/tmp/test',
      bareRepoPath: bareDir,
    };

    // First launch
    const result1 = await launchTeam({
      projectId: 'test-proj',
      teamId: 'relaunch-team',
      briefPath: 'plans/brief.md',
      teamsDir,
      project,
      db: testDb.db,
    });
    assert.equal(result1.roomId, 'relaunch-team');

    // Dissolve the team
    await teamsQ.dissolve(testDb.db, 'relaunch-team');
    const dissolved = await teamsQ.getById(testDb.db, 'relaunch-team');
    assert.equal(dissolved!.status, 'dissolved');

    // Re-launch the same team
    const result2 = await launchTeam({
      projectId: 'test-proj',
      teamId: 'relaunch-team',
      briefPath: 'plans/brief.md',
      teamsDir,
      project,
      db: testDb.db,
    });
    assert.equal(result2.roomId, 'relaunch-team');
    assert.equal(result2.members.length, 2);

    // Verify team is active again
    const team = await teamsQ.getById(testDb.db, 'relaunch-team');
    assert.ok(team);
    assert.equal(team.status, 'active');

    rmSync(teamsDir, { recursive: true, force: true });
  });

  it('resolves hooks with team-level defaults and member overrides', async () => {
    const teamsDir = createTeamsDir('hook-team', {
      id: 'hook-team',
      name: 'Hook Team',
      hooks: { buildIntercept: false, cppLint: false },
      members: [
        {
          agentName: 'leader-h',
          role: 'lead',
          agentType: 'orchestrator',
          isLeader: true,
          hooks: { buildIntercept: true },
        },
        { agentName: 'worker-h', role: 'impl', agentType: 'implementer', isLeader: false },
      ],
    });

    const project: MergedProjectConfig = {
      name: 'Test',
      path: '/tmp/test',
      bareRepoPath: bareDir,
    };

    const result = await launchTeam({
      projectId: 'test-proj',
      teamId: 'hook-team',
      briefPath: 'plans/brief.md',
      teamsDir,
      project,
      db: testDb.db,
    });

    // Leader overrides buildIntercept to true, inherits team cppLint=false
    const leader = result.members.find(m => m.agentName === 'leader-h')!;
    assert.equal(leader.hooks.buildIntercept, true);
    assert.equal(leader.hooks.cppLint, false);

    // Worker inherits both from team defaults
    const worker = result.members.find(m => m.agentName === 'worker-h')!;
    assert.equal(worker.hooks.buildIntercept, false);
    assert.equal(worker.hooks.cppLint, false);

    rmSync(teamsDir, { recursive: true, force: true });
  });
});
