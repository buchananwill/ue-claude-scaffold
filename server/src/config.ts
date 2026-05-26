import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ProjectRow } from "./queries/projects.js";
import { PROJECT_ID_RE } from "./branch-naming.js";

export interface AgentRoleMap {
  engineer: string;
  arbitrator: string;
  reviewers: Record<string, string>;
}

export interface ProjectConfig {
  name: string;
  path: string;
  uprojectFile?: string;
  bareRepoPath: string;
  seedBranch?: string;
  engine?: { path: string; version: string };
  build?: {
    scriptPath?: string;
    testScriptPath?: string;
    buildTimeoutMs?: number;
    testTimeoutMs?: number;
  };
  plugins?: { stagingCopies?: Array<{ source: string; relativeDest: string }> };
  stagingWorktreeRoot?: string;
  agentRoles?: AgentRoleMap;
}

const AGENT_BASENAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const REVIEWER_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_ROLES_TOP_KEYS = new Set(["engineer", "arbitrator", "reviewers"]);

function validateAgentRoles(
  projectId: string,
  raw: unknown,
): AgentRoleMap | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': must be a JSON object`,
    );
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!AGENT_ROLES_TOP_KEYS.has(key)) {
      const suggestion = key.toLowerCase().startsWith("rev")
        ? ` — did you mean 'reviewers'?`
        : "";
      throw new Error(
        `Invalid agentRoles for project '${projectId}': unknown top-level key '${key}'${suggestion}`,
      );
    }
  }

  if (typeof obj.engineer !== "string") {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': missing required field 'engineer'`,
    );
  }
  if (!AGENT_BASENAME_RE.test(obj.engineer)) {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': engineer value '${obj.engineer}' does not match ${AGENT_BASENAME_RE}`,
    );
  }

  if (typeof obj.arbitrator !== "string") {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': missing required field 'arbitrator'`,
    );
  }
  if (!AGENT_BASENAME_RE.test(obj.arbitrator)) {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': arbitrator value '${obj.arbitrator}' does not match ${AGENT_BASENAME_RE}`,
    );
  }

  if (
    obj.reviewers == null ||
    typeof obj.reviewers !== "object" ||
    Array.isArray(obj.reviewers)
  ) {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': missing required field 'reviewers' (must be a JSON object)`,
    );
  }
  const reviewers = obj.reviewers as Record<string, unknown>;
  const reviewerKeys = Object.keys(reviewers);
  if (reviewerKeys.length === 0) {
    throw new Error(
      `Invalid agentRoles for project '${projectId}': reviewers map must have at least one entry`,
    );
  }
  const validatedReviewers: Record<string, string> = {};
  for (const key of reviewerKeys) {
    if (!REVIEWER_KEY_RE.test(key)) {
      throw new Error(
        `Invalid agentRoles for project '${projectId}': reviewer key '${key}' does not match ${REVIEWER_KEY_RE}`,
      );
    }
    const value = reviewers[key];
    if (typeof value !== "string") {
      throw new Error(
        `Invalid agentRoles for project '${projectId}': reviewer value for '${key}' must be a string`,
      );
    }
    if (!AGENT_BASENAME_RE.test(value)) {
      throw new Error(
        `Invalid agentRoles for project '${projectId}': reviewer value '${value}' for key '${key}' does not match ${AGENT_BASENAME_RE}`,
      );
    }
    validatedReviewers[key] = value;
  }

  return {
    engineer: obj.engineer,
    arbitrator: obj.arbitrator,
    reviewers: validatedReviewers,
  };
}

export interface ScaffoldConfig {
  project: {
    name: string;
    path: string;
    uprojectFile: string;
  };
  engine: {
    path: string;
    version: string;
  };
  build: {
    scriptPath: string;
    testScriptPath: string;
    defaultTestFilters: string[];
    buildTimeoutMs: number;
    testTimeoutMs: number;
    ubtRetryCount: number;
    ubtRetryDelayMs: number;
  };
  server: {
    port: number;
    ubtLockTimeoutMs: number;
    stagingWorktreeRoot?: string;
    bareRepoPath: string;
  };
  plugins?: {
    stagingCopies?: Array<{
      source: string;
      relativeDest: string;
    }>;
  };
  tasks?: {
    seedBranch?: string;
  };
  /** @deprecated No longer used — CLAUDE.md is now environment-agnostic. */
  claudeMdPatches?: {
    pathRemaps: Record<string, string>;
    agentSubstitutions: Record<string, string>;
  };
  resolvedProjects: Record<string, ProjectConfig>;
  /** Directory containing scaffold.config.json (used to derive relative paths like teamsDir). */
  configDir: string;
}

export function loadConfig(): ScaffoldConfig {
  const candidates = [
    path.resolve("scaffold.config.json"),
    path.resolve("..", "scaffold.config.json"),
  ];

  let configPath: string | undefined;
  for (const c of candidates) {
    if (existsSync(c)) {
      configPath = c;
      break;
    }
  }

  if (!configPath) {
    throw new Error(
      `scaffold.config.json not found. Searched:\n  ${candidates.join("\n  ")}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON with optional-chained access throughout
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`scaffold.config.json is not valid JSON: ${message}`);
  }

  const config: ScaffoldConfig = {
    project: {
      name: raw.project?.name ?? "UnnamedProject",
      path: raw.project?.path ?? "",
      uprojectFile: raw.project?.uprojectFile ?? "",
    },
    engine: {
      path: raw.engine?.path ?? "",
      version: raw.engine?.version ?? "",
    },
    build: {
      scriptPath: raw.build?.scriptPath ?? "",
      testScriptPath: raw.build?.testScriptPath ?? "",
      defaultTestFilters: raw.build?.defaultTestFilters ?? [],
      // 8h ceiling — a from-clean UE build (even engine-from-source) fits under
      // this. This is the hard kill on a genuinely hung build, not an expected
      // duration. The UBT lock is held for the build's real lifetime via the
      // in-memory build registry, independent of this timer.
      buildTimeoutMs:
        coercePositiveNumber(raw.build?.buildTimeoutMs) ?? 28_800_000,
      testTimeoutMs:
        coercePositiveNumber(raw.build?.testTimeoutMs) ?? 28_800_000,
      ubtRetryCount: coercePositiveNumber(raw.build?.ubtRetryCount) ?? 5,
      ubtRetryDelayMs:
        coercePositiveNumber(raw.build?.ubtRetryDelayMs) ?? 30_000,
    },
    server: {
      port: raw.server?.port ?? 9100,
      ubtLockTimeoutMs:
        coercePositiveNumber(raw.server?.ubtLockTimeoutMs) ?? 600_000,
      stagingWorktreeRoot: raw.server?.stagingWorktreeRoot,
      bareRepoPath: raw.server?.bareRepoPath ?? "",
    },
    plugins: {
      stagingCopies: Array.isArray(raw.plugins?.stagingCopies)
        ? raw.plugins.stagingCopies.map((e: Record<string, unknown>) => ({
            source: String(e.source ?? ""),
            relativeDest: String(e.relativeDest ?? ""),
          }))
        : [],
    },
    tasks: {
      seedBranch: raw.tasks?.seedBranch ?? raw.tasks?.planBranch,
    },
    resolvedProjects: {},
    configDir: path.dirname(configPath),
  };

  // Build resolvedProjects from explicit projects block or synthesise from legacy fields.
  // When an explicit `projects` block is present, legacy top-level fields (project, engine, build)
  // are ignored — only the projects block is used to populate resolvedProjects.
  if (raw.projects && typeof raw.projects === "object") {
    for (const [id, p] of Object.entries(
      raw.projects as Record<string, Record<string, unknown>>,
    )) {
      if (!PROJECT_ID_RE.test(id)) {
        throw new Error(
          `Invalid project ID "${id}": must be 1-64 characters matching [a-zA-Z0-9_-].`,
        );
      }
      config.resolvedProjects[id] = parseProjectConfig(id, p);
    }
  } else {
    // Synthesise default project from legacy top-level fields
    config.resolvedProjects["default"] = {
      name: config.project.name,
      path: config.project.path,
      uprojectFile: config.project.uprojectFile || undefined,
      bareRepoPath: config.server.bareRepoPath,
      seedBranch: config.tasks?.seedBranch,
      engine: config.engine.path
        ? { path: config.engine.path, version: config.engine.version }
        : undefined,
      build: config.build.scriptPath
        ? {
            scriptPath: config.build.scriptPath,
            testScriptPath: config.build.testScriptPath || undefined,
            buildTimeoutMs: config.build.buildTimeoutMs,
            testTimeoutMs: config.build.testTimeoutMs,
          }
        : undefined,
      plugins: config.plugins,
      stagingWorktreeRoot: config.server.stagingWorktreeRoot,
    };
  }

  validateConfig(config, !!raw.projects);

  return config;
}

function validateConfig(
  config: ScaffoldConfig,
  hasExplicitProjects: boolean,
): void {
  const missing: string[] = [];

  if (hasExplicitProjects) {
    for (const [id, proj] of Object.entries(config.resolvedProjects)) {
      if (!proj.bareRepoPath) missing.push(`projects.${id}.bareRepoPath`);
      if (!proj.path) missing.push(`projects.${id}.path`);
      if (proj.engine) {
        if (!proj.engine.path) missing.push(`projects.${id}.engine.path`);
        if (!proj.engine.version) missing.push(`projects.${id}.engine.version`);
      }
      if (proj.build?.scriptPath && !proj.build.testScriptPath) {
        missing.push(`projects.${id}.build.testScriptPath`);
      }
      if (proj.build?.testScriptPath && !proj.build.scriptPath) {
        missing.push(`projects.${id}.build.scriptPath`);
      }
    }
  } else {
    if (!config.project.path) missing.push("project.path");
    if (
      config.engine.path !== "" ||
      config.build.scriptPath !== "" ||
      config.build.testScriptPath !== ""
    ) {
      // Legacy config with engine/build declared — require them fully
      if (!config.engine.path) missing.push("engine.path");
      if (!config.build.scriptPath) missing.push("build.scriptPath");
      if (!config.build.testScriptPath) missing.push("build.testScriptPath");
    }
    if (!config.server.stagingWorktreeRoot && !config.project.path) {
      missing.push("server.stagingWorktreeRoot (or project.path as fallback)");
    }
  }

  if (!config.server.bareRepoPath && !hasExplicitProjects) {
    missing.push("server.bareRepoPath");
  }

  if (missing.length > 0) {
    throw new Error(
      `scaffold.config.json is missing required fields:\n` +
        missing.map((f) => `  - ${f}`).join("\n") +
        `\n\nCopy scaffold.config.example.json and fill in the paths for your project.`,
    );
  }

  const port = config.server.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`server.port must be 1–65535 (got ${port})`);
  }
}

function coercePositiveNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseProjectConfig(
  id: string,
  p: Record<string, unknown>,
): ProjectConfig {
  const build = p.build as Record<string, unknown> | undefined;
  const engine = p.engine as Record<string, unknown> | undefined;
  const plugins = p.plugins as Record<string, unknown> | undefined;
  return {
    name: String(p.name ?? id),
    path: String(p.path ?? ""),
    uprojectFile: p.uprojectFile != null ? String(p.uprojectFile) : undefined,
    bareRepoPath: String(p.bareRepoPath ?? ""),
    seedBranch:
      p.seedBranch != null
        ? String(p.seedBranch)
        : p.planBranch != null
          ? String(p.planBranch)
          : undefined,
    engine: engine
      ? {
          path: String(engine.path ?? ""),
          version: String(engine.version ?? ""),
        }
      : undefined,
    build: build
      ? {
          scriptPath:
            build.scriptPath != null ? String(build.scriptPath) : undefined,
          testScriptPath:
            build.testScriptPath != null
              ? String(build.testScriptPath)
              : undefined,
          buildTimeoutMs: coercePositiveNumber(build.buildTimeoutMs),
          testTimeoutMs: coercePositiveNumber(build.testTimeoutMs),
        }
      : undefined,
    plugins: plugins
      ? {
          stagingCopies: Array.isArray(plugins.stagingCopies)
            ? (plugins.stagingCopies as Record<string, unknown>[]).map((e) => ({
                source: String(e.source ?? ""),
                relativeDest: String(e.relativeDest ?? ""),
              }))
            : undefined,
        }
      : undefined,
    stagingWorktreeRoot:
      p.stagingWorktreeRoot != null ? String(p.stagingWorktreeRoot) : undefined,
    agentRoles: validateAgentRoles(id, p.agentRoles),
  };
}

export interface MergedProjectConfig extends ProjectConfig {
  /** Portable fields from DB (null if project not in DB) */
  dbRecord?: {
    engineVersion: string | null;
    seedBranch: string | null;
    buildTimeoutMs: number | null;
    testTimeoutMs: number | null;
  };
}

/**
 * Get a project's config by merging local paths from JSON config with
 * portable fields from the DB row (if provided).
 *
 * DB values override JSON values for portable fields (name, timeouts, seed branch).
 */
export function getProject(
  config: ScaffoldConfig,
  id: string,
  dbRow?: ProjectRow | null,
): MergedProjectConfig {
  const project = config.resolvedProjects[id];
  if (!project) {
    throw new Error(
      `Unknown project: "${id.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "?")}"`,
    );
  }

  if (!dbRow) {
    return { ...project };
  }

  // Merge: DB is authoritative for portable fields
  const merged: MergedProjectConfig = { ...project };

  // DB name overrides JSON name
  merged.name = dbRow.name;

  // DB seed branch overrides JSON seed branch
  if (dbRow.seedBranch != null) {
    merged.seedBranch = dbRow.seedBranch;
  }

  // DB timeouts override JSON build timeouts
  if (merged.build) {
    if (dbRow.buildTimeoutMs != null) {
      merged.build = { ...merged.build, buildTimeoutMs: dbRow.buildTimeoutMs };
    }
    if (dbRow.testTimeoutMs != null) {
      merged.build = { ...merged.build, testTimeoutMs: dbRow.testTimeoutMs };
    }
  }

  // DB engine version overrides JSON engine version
  if (dbRow.engineVersion != null && merged.engine) {
    merged.engine = { ...merged.engine, version: dbRow.engineVersion };
  }

  merged.dbRecord = {
    engineVersion: dbRow.engineVersion,
    seedBranch: dbRow.seedBranch,
    buildTimeoutMs: dbRow.buildTimeoutMs,
    testTimeoutMs: dbRow.testTimeoutMs,
  };

  return merged;
}
