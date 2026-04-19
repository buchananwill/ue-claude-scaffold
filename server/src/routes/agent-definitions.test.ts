import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import agentDefinitionsPlugin from './agent-definitions.js';
import type { ScaffoldConfig } from '../config.js';
import { createTestConfig } from '../test-helper.js';

/**
 * Create a temporary directory tree simulating the repo layout with
 * agents/, dynamic-agents/, and skills/ directories.
 */
function createTestRepoLayout(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-def-test-'));
  const agentsDir = path.join(repoRoot, 'agents');
  const dynamicDir = path.join(repoRoot, 'dynamic-agents');
  const skillsDir = path.join(repoRoot, 'skills');

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(dynamicDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  // Static agent: no skills in frontmatter
  fs.writeFileSync(
    path.join(agentsDir, 'static-agent.md'),
    [
      '---',
      'name: static-agent',
      'description: A static agent with no skills',
      'model: opus',
      'tools: [Read, Edit]',
      '---',
      '',
      '# Static Agent',
      '',
      'This is a static agent definition.',
      '',
    ].join('\n'),
  );

  // Create a skill for the dynamic agent
  const skillDir = path.join(skillsDir, 'test-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: test-skill',
      'description: A test skill',
      'axis: testing',
      '---',
      '',
      '***ACCESS SCOPE: write-access***',
      '',
      '# Test Skill',
      '',
      'Skill content here.',
      '',
    ].join('\n'),
  );

  // Dynamic agent: has skills in frontmatter
  fs.writeFileSync(
    path.join(dynamicDir, 'dynamic-agent.md'),
    [
      '---',
      'name: dynamic-agent',
      'description: A dynamic agent with skills',
      'model: opus',
      'tools: [Read, Edit, Bash]',
      'skills:',
      '  - test-skill',
      '---',
      '',
      '# Dynamic Agent',
      '',
      'This is a dynamic agent template.',
      '',
    ].join('\n'),
  );

  return {
    repoRoot,
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }),
  };
}

describe('GET /agents/definitions/:type', () => {
  let ctx: DrizzleTestContext;
  let layout: ReturnType<typeof createTestRepoLayout>;
  let config: ScaffoldConfig;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    layout = createTestRepoLayout();
    config = createTestConfig({ configDir: layout.repoRoot });
    await ctx.app.register(agentDefinitionsPlugin, { config });
  });

  afterEach(async () => {
    await ctx?.app.close();
    await ctx?.cleanup();
    layout?.cleanup();
  });

  it('returns a static agent definition with default meta', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/definitions/static-agent',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.agentType, 'static-agent');
    assert.ok(body.markdown.includes('# Static Agent'));
    assert.deepEqual(body.meta, { 'access-scope': 'read-only' });
  });

  it('returns a compiled dynamic agent definition with sidecar meta', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/definitions/dynamic-agent',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.agentType, 'dynamic-agent');
    // The compiled output should contain the skill content
    assert.ok(body.markdown.includes('# Test Skill'));
    assert.ok(body.markdown.includes('Skill content here.'));
    // Meta should reflect the skill's access scope
    assert.equal(body.meta['access-scope'], 'write-access');
  });

  it('returns 404 for nonexistent agent type', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/definitions/nonexistent',
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 for invalid agent type name', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/definitions/bad%20name!!',
    });
    assert.equal(res.statusCode, 400);
  });

  it('prefers dynamic-agents over static agents for the same name', async () => {
    // Create a static agent with the same name as the dynamic one
    fs.writeFileSync(
      path.join(layout.repoRoot, 'agents', 'dynamic-agent.md'),
      [
        '---',
        'name: dynamic-agent',
        'description: Static version',
        'model: opus',
        'tools: [Read]',
        '---',
        '',
        '# Static Version of Dynamic Agent',
        '',
      ].join('\n'),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/definitions/dynamic-agent',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // Should get the dynamic (compiled) version, not the static one
    assert.ok(body.markdown.includes('# Test Skill'));
    assert.equal(body.meta['access-scope'], 'write-access');
  });

  it('treats a dynamic-agents file without skills as static', async () => {
    // Create a file in dynamic-agents/ but without skills
    fs.writeFileSync(
      path.join(layout.repoRoot, 'dynamic-agents', 'no-skills-agent.md'),
      [
        '---',
        'name: no-skills-agent',
        'description: A dynamic-dir agent with no skills',
        'model: opus',
        'tools: [Read]',
        '---',
        '',
        '# No Skills Agent',
        '',
      ].join('\n'),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/definitions/no-skills-agent',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.agentType, 'no-skills-agent');
    // Without skills, it should be treated as static with default meta
    assert.deepEqual(body.meta, { 'access-scope': 'read-only' });
  });
});
