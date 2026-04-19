/**
 * Branch-naming helpers for project-namespaced git branches.
 *
 * Naming convention:
 *   seed branch:  docker/{projectId}/current-root  (default, unless overridden)
 *   agent branch: docker/{projectId}/{agentName}
 */

// Note: git-illegal sequences @{, ~, ^, *, ?, [, \, space, and control chars
// are excluded by the character class [a-zA-Z0-9/_.-] — no explicit lookahead needed.
export const BRANCH_RE = /^(?![.\/])(?!.*\/\/)(?!.*\.\.)(?!.*\.$)(?!.*\/$)(?!.*\.lock(?:\/|$))(?!.*\/\.)(?!.*\.\/)[a-zA-Z0-9/_.-]{1,200}$/;
export const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/**
 * Returns the seed (integration) branch name for a project.
 *
 * If `projectConfig.seedBranch` is set to a non-empty string, that value is
 * returned verbatim after validation.  An empty string is treated as "not set"
 * and falls back to the default `docker/{projectId}/current-root`.
 */
export function seedBranchFor(projectId: string, projectConfig?: { seedBranch?: string | null }): string {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(`Invalid projectId: "${projectId}"`);
  }
  if (projectConfig?.seedBranch) {
    if (!BRANCH_RE.test(projectConfig.seedBranch)) {
      throw new Error(`Invalid seedBranch: "${projectConfig.seedBranch}"`);
    }
    return projectConfig.seedBranch;
  }
  return `docker/${projectId}/current-root`;
}

export function agentBranchFor(projectId: string, agentName: string): string {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(`Invalid projectId: "${projectId}"`);
  }
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(`Invalid agentName: "${agentName}"`);
  }
  return `docker/${projectId}/${agentName}`;
}

/**
 * Validate the agentTypeOverride field.
 *
 * In `create` mode: rejects `null` (must be a string or omitted); rejects
 * invalid strings; passes valid strings or undefined.
 *
 * In `patch` mode: allows `null` (for clearing); rejects invalid non-null
 * strings; passes valid strings or undefined.
 */
export function validateAgentTypeOverride(
  value: unknown,
  mode: 'create' | 'patch',
): { valid: true; value: string | null } | { valid: false; error: string } {
  if (value === undefined) {
    return { valid: true, value: null };
  }
  if (value === null) {
    if (mode === 'create') {
      return { valid: false, error: 'agentTypeOverride must be a string or omitted, not null' };
    }
    // patch mode — null clears the override
    return { valid: true, value: null };
  }
  if (typeof value !== 'string' || !isValidAgentName(value)) {
    return {
      valid: false,
      error:
        `Invalid agentTypeOverride: "${String(value).slice(0, 64)}". ` +
        'Must match agent name format (alphanumeric, hyphens, underscores; 1-64 chars).',
    };
  }
  return { valid: true, value };
}
