import type { FastifyPluginAsync } from "fastify";
import type { ScaffoldConfig } from "../config.js";
import { syncExteriorToBareRepo } from "../git-utils.js";
import { getDb } from "../drizzle-instance.js";
import { seedBranchFor } from "../branch-naming.js";
import { resolveProject } from "../resolve-project.js";

interface SyncOpts {
  config: ScaffoldConfig;
}

const syncPlugin: FastifyPluginAsync<SyncOpts> = async (fastify, opts) => {
  const { config } = opts;

  // POST /sync/plans — force-set docker/<project>/current-root to the exterior
  // repo's HEAD. Only the seed branch is mutated; agent branches are reset
  // exclusively via `launch.sh --fresh`.
  fastify.post("/sync/plans", async (request, reply) => {
    const projectId = request.projectId;
    let project;
    try {
      project = await resolveProject(config, getDb(), projectId);
    } catch {
      return reply.badRequest(`Unknown project: "${projectId}"`);
    }

    const bareRepo = project.bareRepoPath;
    if (!bareRepo) {
      return reply.unprocessableEntity("bareRepoPath is not configured");
    }

    const exteriorRepo = project.path;
    if (!exteriorRepo) {
      return reply.unprocessableEntity("project.path is not configured");
    }

    const seedBranch = seedBranchFor(projectId, project);

    const syncResult = syncExteriorToBareRepo(
      exteriorRepo,
      bareRepo,
      seedBranch,
      fastify.log,
    );

    if (!syncResult.ok) {
      return reply.code(409).send({
        ok: false,
        reason: syncResult.reason,
      });
    }

    const { exteriorHead, previousSeed } = syncResult;
    return {
      ok: true,
      exteriorHead,
      previousSeed,
      changed: previousSeed !== exteriorHead,
    };
  });
};

export default syncPlugin;
