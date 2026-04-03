import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { seedBranchFor, agentBranchFor } from './branch-naming.js';

describe('seedBranchFor', () => {
  it('returns default docker/{projectId}/current-root when no config provided', () => {
    assert.equal(seedBranchFor('my-project'), 'docker/my-project/current-root');
  });

  it('returns default when config has null seedBranch', () => {
    assert.equal(seedBranchFor('my-project', { seedBranch: null }), 'docker/my-project/current-root');
  });

  it('returns default when config has undefined seedBranch', () => {
    assert.equal(seedBranchFor('my-project', { seedBranch: undefined as unknown as string | null }), 'docker/my-project/current-root');
  });

  it('returns default when config has empty string seedBranch', () => {
    assert.equal(seedBranchFor('my-project', { seedBranch: '' }), 'docker/my-project/current-root');
  });

  it('returns explicit seedBranch when set', () => {
    assert.equal(seedBranchFor('my-project', { seedBranch: 'custom/branch' }), 'custom/branch');
  });

  it('uses the projectId in the default branch name', () => {
    assert.equal(seedBranchFor('alpha'), 'docker/alpha/current-root');
    assert.equal(seedBranchFor('beta-2'), 'docker/beta-2/current-root');
  });

  it('throws on invalid seedBranch with path traversal', () => {
    assert.throws(
      () => seedBranchFor('proj', { seedBranch: 'refs/../../../config' }),
      /Invalid seedBranch/
    );
  });

  it('throws on invalid projectId', () => {
    assert.throws(
      () => seedBranchFor('../evil'),
      /Invalid projectId/
    );
  });
});

describe('agentBranchFor', () => {
  it('returns docker/{projectId}/{agentName}', () => {
    assert.equal(agentBranchFor('my-project', 'agent-1'), 'docker/my-project/agent-1');
  });

  it('handles various project and agent names', () => {
    assert.equal(agentBranchFor('alpha', 'worker-3'), 'docker/alpha/worker-3');
    assert.equal(agentBranchFor('beta_project', 'implementer'), 'docker/beta_project/implementer');
  });

  it('throws on path-traversal projectId', () => {
    assert.throws(
      () => agentBranchFor('../evil', 'agent-1'),
      /Invalid projectId/
    );
  });

  it('throws on path-traversal agentName', () => {
    assert.throws(
      () => agentBranchFor('proj', '../other'),
      /Invalid agentName/
    );
  });

  it('throws on empty projectId', () => {
    assert.throws(
      () => agentBranchFor('', 'agent-1'),
      /Invalid projectId/
    );
  });

  it('throws on empty agentName', () => {
    assert.throws(
      () => agentBranchFor('proj', ''),
      /Invalid agentName/
    );
  });
});
