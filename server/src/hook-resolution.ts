/**
 * Server-side hook flag resolution.
 *
 * Resolves buildIntercept and cppLint flags via a 5-level cascade:
 *   1. System default (buildIntercept=true if hasBuildScript, cppLint=false)
 *   2. Project-level override
 *   3. Team-level override
 *   4. Member-level override
 *   5. CLI-level override
 *
 * At each level, a non-null/non-undefined value replaces the current result.
 */

export interface HookFlags {
  buildIntercept?: boolean | null;
  cppLint?: boolean | null;
  jsLint?: boolean | null;
}

export interface HookResolutionInput {
  hasBuildScript: boolean;
  projectHooks?: HookFlags;
  teamHooks?: HookFlags;
  memberHooks?: HookFlags;
  cliOverride?: HookFlags;
}

export interface ResolvedHooks {
  buildIntercept: boolean;
  cppLint: boolean;
  jsLint: boolean;
}

/**
 * Apply a cascade of overrides to a system default.
 * Each non-null/non-undefined value in the overrides list replaces the current result.
 */
function cascadeFlag(
  systemDefault: boolean,
  ...overrides: (boolean | null | undefined)[]
): boolean {
  let result = systemDefault;
  for (const override of overrides) {
    if (override != null) result = override;
  }
  return result;
}

/**
 * Resolve hook flags by applying the 5-level cascade.
 */
export function resolveHooks(input: HookResolutionInput): ResolvedHooks {
  const { hasBuildScript, projectHooks, teamHooks, memberHooks, cliOverride } =
    input;

  return {
    buildIntercept: cascadeFlag(
      hasBuildScript,
      projectHooks?.buildIntercept,
      teamHooks?.buildIntercept,
      memberHooks?.buildIntercept,
      cliOverride?.buildIntercept,
    ),
    cppLint: cascadeFlag(
      false,
      projectHooks?.cppLint,
      teamHooks?.cppLint,
      memberHooks?.cppLint,
      cliOverride?.cppLint,
    ),
    jsLint: cascadeFlag(
      false,
      projectHooks?.jsLint,
      teamHooks?.jsLint,
      memberHooks?.jsLint,
      cliOverride?.jsLint,
    ),
  };
}
