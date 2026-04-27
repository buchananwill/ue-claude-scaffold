/**
 * Agent definitions route.
 *
 * GET /agents/definitions/:type — compile and return an agent definition
 * (markdown + meta.json sidecar) on demand.
 */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import type { ScaffoldConfig } from "../config.js";
import { AGENT_NAME_RE } from "../branch-naming.js";
import {
  compileAgent,
  compileAgentWithSubAgents,
  findSubAgents,
  parseFrontmatter,
} from "../agent-compiler.js";
import type { FastifyInstance } from "fastify";

interface AgentDefinitionsOpts {
  config: ScaffoldConfig;
}

const AGENT_NAME_PATTERN = AGENT_NAME_RE.source;

/** Return true if `filePath` exists on disk. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a sidecar meta.json file written by the agent compiler. */
async function readMetaJson(
  metaPath: string,
  app: FastifyInstance,
): Promise<unknown> {
  const raw = await fs.readFile(metaPath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    throw app.httpErrors.internalServerError(
      "Failed to parse compiled agent metadata",
    );
  }
}

/**
 * Compile one sub-agent for inclusion in a static lead's response bundle.
 *
 * Static agents have no skills frontmatter, so the lead is served verbatim,
 * but their body may still reference dynamic sub-agents that need full
 * compilation. This helper compiles one such sub-agent and reads back its
 * markdown plus sidecar meta.
 */
function compileSubAgentForResponse(
  subSrc: string,
  outputDir: string,
  skillsDir: string,
): { markdown: string; meta: unknown } {
  compileAgent(subSrc, outputDir, skillsDir);
  const stem = path.basename(subSrc, ".md");
  const compiledPath = path.join(outputDir, `${stem}.md`);
  const metaPath = path.join(outputDir, `${stem}.meta.json`);
  const markdown = fsSync.readFileSync(compiledPath, "utf-8");
  const metaRaw = fsSync.readFileSync(metaPath, "utf-8");
  return { markdown, meta: JSON.parse(metaRaw) };
}

const agentDefinitionsPlugin: FastifyPluginAsync<AgentDefinitionsOpts> = async (
  app,
  { config },
) => {
  app.get<{ Params: { type: string } }>(
    "/agents/definitions/:type",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            type: { type: "string", pattern: AGENT_NAME_PATTERN },
          },
          required: ["type"],
        },
      },
    },
    async (request, reply) => {
      const { type } = request.params;

      const repoRoot = config.configDir;
      const dynamicDir = path.join(repoRoot, "dynamic-agents");
      const staticDir = path.join(repoRoot, "agents");
      const skillsDir = path.join(repoRoot, "skills");

      // Locate source: dynamic-agents/{type}.md first, then agents/{type}.md
      const dynamicPath = path.join(dynamicDir, `${type}.md`);
      const staticPath = path.join(staticDir, `${type}.md`);

      let sourcePath: string | null = null;
      let isDynamic = false;

      if (await fileExists(dynamicPath)) {
        sourcePath = dynamicPath;
        // Check if it has skills in frontmatter
        const text = await fs.readFile(dynamicPath, "utf-8");
        const { meta } = parseFrontmatter(text);
        isDynamic = Array.isArray(meta["skills"]) && meta["skills"].length > 0;
      } else if (await fileExists(staticPath)) {
        sourcePath = staticPath;
        isDynamic = false;
      }

      if (!sourcePath) {
        return reply.notFound("Agent type not found");
      }

      // Dynamic and static agents both need sub-agent bundling. The lead is
      // compiled (or read as-is for static); its body is then scanned against
      // dynamic-agents/ for one-level sub-agent references, and each match is
      // compiled and returned alongside the lead.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-def-"));
      try {
        if (isDynamic) {
          // compileAgentWithSubAgents is synchronous — same rationale as
          // compileAgent: sub-millisecond per definition, used by both the CLI
          // and this endpoint, async offers no benefit.
          const result = compileAgentWithSubAgents(
            sourcePath,
            tmpDir,
            skillsDir,
            dynamicDir,
          );

          const markdown = await fs.readFile(result.main.outputPath, "utf-8");
          const meta = await readMetaJson(
            path.join(tmpDir, `${type}.meta.json`),
            app,
          );

          const subAgents = await Promise.all(
            result.subAgents.map(async (sub) => ({
              agentType: sub.type,
              markdown: await fs.readFile(sub.outputPath, "utf-8"),
              meta: await readMetaJson(
                path.join(tmpDir, `${sub.type}.meta.json`),
                app,
              ),
            })),
          );

          return {
            agentType: type,
            markdown,
            meta,
            subAgents,
            warnings: result.warnings,
          };
        }

        // Static agent: serve verbatim, but still discover sub-agents in its
        // body so the caller receives the full dispatch set in one round-trip.
        const markdown = await fs.readFile(sourcePath, "utf-8");
        const subAgentPaths = fsSync.existsSync(dynamicDir)
          ? findSubAgents(markdown, dynamicDir, new Set([type]))
          : [];

        const subAgents = subAgentPaths.map((subSrc) => {
          const subStem = path.basename(subSrc, ".md");
          const subResult = compileSubAgentForResponse(
            subSrc,
            tmpDir,
            skillsDir,
          );
          return {
            agentType: subStem,
            markdown: subResult.markdown,
            meta: subResult.meta,
          };
        });

        return {
          agentType: type,
          markdown,
          meta: { "access-scope": "read-only" },
          subAgents,
          warnings: [],
        };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
};

export default agentDefinitionsPlugin;
