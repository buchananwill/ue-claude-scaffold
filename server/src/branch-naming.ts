/**
 * Branch-naming helpers for project-namespaced git branches.
 *
 * Naming convention:
 *   seed branch:  docker/{projectId}/current-root  (default, unless overridden)
 *   agent branch: docker/{projectId}/{agentName}
 */

export function seedBranchFor(projectId: string, projectConfig?: { seedBranch?: string | null }): string {
  if (projectConfig?.seedBranch) {
    return projectConfig.seedBranch;
  }
  return `docker/${projectId}/current-root`;
}

export function agentBranchFor(projectId: string, agentName: string): string {
  return `docker/${projectId}/${agentName}`;
}
