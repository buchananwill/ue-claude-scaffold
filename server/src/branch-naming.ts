/**
 * Branch-naming helpers for project-namespaced git branches.
 *
 * Naming convention:
 *   seed branch:  docker/{projectId}/current-root  (default, unless overridden)
 *   agent branch: docker/{projectId}/{agentName}
 */


// Note: git-illegal sequences @{, ~, ^, *, ?, [, \, space, and control chars
// are excluded by the character class [a-zA-Z0-9/_.-] — no explicit lookahead needed.
const BRANCH_RE = /^(?![.\/])(?!.*\/\/)(?!.*\.\.)(?!.*\.$)(?!.*\/$)(?!.*\.lock(?:\/|$))(?!.*\/\.)(?!.*\.\/)[a-zA-Z0-9/_.-]{1,200}$/;
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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
