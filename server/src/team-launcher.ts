/**
 * Server-side team launch logic.
 *
 * Validates a team definition, registers the team + room, posts the brief,
 * sets up agent branch refs, and returns a launch plan for the shell caller.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { DrizzleDb } from './drizzle-instance.js';
import type { MergedProjectConfig } from './config.js';
import { seedBranchFor, agentBranchFor, AGENT_NAME_RE } from './branch-naming.js';
import { ensureAgentBranch } from './branch-ops.js';
import * as teamsQ from './queries/teams.js';
import * as roomsQ from './queries/rooms.js';
import * as chatQ from './queries/chat.js';

/** A member entry from the team definition JSON file. */
export interface TeamDefMember {
  agentName: string;
  role: string;
  agentType: string;
  isLeader?: boolean;
  hooks?: { buildIntercept?: boolean; cppLint?: boolean };
}

/** The shape of a team definition JSON file on disk. */
export interface TeamDef {
  id: string;
  name: string;
  hooks?: { buildIntercept?: boolean; cppLint?: boolean };
  members: TeamDefMember[];
}

/** Options for launchTeam(). */
export interface LaunchTeamOpts {
  projectId: string;
  teamId: string;
  briefPath: string;
  /** Path to the teams/ directory containing <teamId>.json */
  teamsDir: string;
  /** The project config (provides bareRepoPath, seedBranch, etc.) */
  project: MergedProjectConfig;
  /** Drizzle database instance */
  db: DrizzleDb;
}

/** Per-member info in the launch plan returned by launchTeam(). */
export interface LaunchMember {
  agentName: string;
  agentType: string;
  branch: string;
  role: string;
  isLeader: boolean;
  hooks: { buildIntercept: boolean; cppLint: boolean };
}

/** The result of a successful launchTeam() call. */
export interface LaunchTeamResult {
  roomId: string;
  members: LaunchMember[];
}

/**
 * Validate the brief exists on the seed branch in the bare repo.
 * Throws a descriptive error if not found.
 */
export function validateBriefOnSeedBranch(
  bareRepoPath: string,
  projectId: string,
  briefPath: string,
  seedBranchOverride?: string | null,
): void {
  const branch = seedBranchFor(projectId, seedBranchOverride ? { seedBranch: seedBranchOverride } : undefined);
  const result = spawnSync('git', ['cat-file', '-e', `${branch}:${briefPath}`], {
    cwd: bareRepoPath,
    timeout: 5000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Brief not found on ${branch}: ${briefPath}. ` +
      `Commit the brief in the exterior repo and sync with POST /sync/plans first.`
    );
  }
}

/**
 * Load and validate a team definition JSON file from the teams directory.
 */
export function loadTeamDef(teamsDir: string, teamId: string): TeamDef {
  if (!AGENT_NAME_RE.test(teamId)) {
    throw new Error(`Invalid teamId '${teamId}' — must match ^[a-zA-Z0-9_-]{1,64}$`);
  }
  const defPath = path.join(teamsDir, `${teamId}.json`);
  if (!existsSync(defPath)) {
    throw new Error(`Team definition not found: ${defPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(defPath, 'utf-8'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid team definition JSON: ${msg}`);
  }

  const def = raw as TeamDef;
  if (!def.id || !def.name || !Array.isArray(def.members) || def.members.length === 0) {
    throw new Error(`Team definition is missing required fields (id, name, members)`);
  }

  // Validate exactly one leader
  const leaders = def.members.filter(m => m.isLeader);
  if (leaders.length !== 1) {
    throw new Error(`Exactly one discussion leader is required (found ${leaders.length})`);
  }

  // Validate no duplicate agent names
  const names = def.members.map(m => m.agentName);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate member agentName: ${[...new Set(dupes)].join(', ')}`);
  }

  // Validate each member has required fields and valid formats
  for (const m of def.members) {
    if (!m.agentName) throw new Error('Team member missing required field: agentName');
    if (!AGENT_NAME_RE.test(m.agentName)) {
      throw new Error(`Team member agentName '${m.agentName}' contains invalid characters`);
    }
    if (!m.agentType) throw new Error(`Team member '${m.agentName}' missing required field: agentType`);
    if (!AGENT_NAME_RE.test(m.agentType)) {
      throw new Error(`Team member '${m.agentName}' has invalid agentType '${m.agentType}' — must match ^[a-zA-Z0-9_-]{1,64}$`);
    }
    if (!m.role) throw new Error(`Team member '${m.agentName}' missing required field: role`);
  }

  return def;
}

/**
 * Resolve hook settings for a member, cascading team-level defaults with member overrides.
 */
function resolveHooks(
  teamHooks: TeamDef['hooks'],
  memberHooks: TeamDefMember['hooks'],
): { buildIntercept: boolean; cppLint: boolean } {
  const defaults = { buildIntercept: true, cppLint: true };
  return {
    buildIntercept: memberHooks?.buildIntercept ?? teamHooks?.buildIntercept ?? defaults.buildIntercept,
    cppLint: memberHooks?.cppLint ?? teamHooks?.cppLint ?? defaults.cppLint,
  };
}

/**
 * Launch a team: validate inputs, register in DB, post brief, set up branches.
 *
 * This is the server-side logic that replaces the shell-based team launch block.
 */
export async function launchTeam(opts: LaunchTeamOpts): Promise<LaunchTeamResult> {
  const { projectId, teamId, briefPath, teamsDir, project, db } = opts;
  const bareRepoPath = project.bareRepoPath;

  // 1. Validate brief exists on seed branch
  validateBriefOnSeedBranch(bareRepoPath, projectId, briefPath, project.seedBranch);

  // 2. Load and validate team definition
  const def = loadTeamDef(teamsDir, teamId);

  // 3. Check for duplicate registration and register in a transaction
  const roomId = def.id;

  await db.transaction(async (tx) => {
    const existing = await teamsQ.getById(tx, def.id);
    if (existing) {
      if (existing.status !== 'dissolved') {
        throw new Error(`Team '${def.id}' already exists and is ${existing.status}`);
      }
      // Clean up dissolved team data before re-registration
      await roomsQ.deleteRoom(tx, def.id);
      await teamsQ.deleteTeam(tx, def.id);
    }

    // 4. Register team + room in DB (uses the createWithRoom helper)
    await teamsQ.createWithRoom(tx, {
      id: def.id,
      name: def.name,
      briefPath,
      projectId,
      createdBy: 'user',
      members: def.members.map(m => ({
        agentName: m.agentName,
        role: m.role,
        isLeader: m.isLeader,
      })),
    });

    // 5. Post brief path as the first room message
    await chatQ.sendMessage(tx, {
      roomId,
      sender: 'user',
      content: `Brief: \`${briefPath}\` -- read this file from your workspace to begin.`,
    });
  });

  // 6. Set up agent branch refs (fresh reset to seed branch HEAD)
  const members: LaunchMember[] = [];
  // Process leader first, then non-leaders
  const sorted = [...def.members].sort((a, b) => {
    if (a.isLeader && !b.isLeader) return -1;
    if (!a.isLeader && b.isLeader) return 1;
    return 0;
  });

  for (const m of sorted) {
    const branchResult = ensureAgentBranch({
      bareRepoPath,
      projectId,
      agentName: m.agentName,
      fresh: true,
      seedBranch: project.seedBranch,
    });

    members.push({
      agentName: m.agentName,
      agentType: m.agentType,
      branch: branchResult.branch,
      role: m.role,
      isLeader: m.isLeader ?? false,
      hooks: resolveHooks(def.hooks, m.hooks),
    });
  }

  return { roomId, members };
}
