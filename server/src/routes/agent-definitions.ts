/**
 * Agent definitions route.
 *
 * GET /agents/definitions/:type — compile and return an agent definition
 * (markdown + meta.json sidecar) on demand.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { AGENT_NAME_RE } from '../branch-naming.js';
import { compileAgent, parseFrontmatter } from '../agent-compiler.js';

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

const agentDefinitionsPlugin: FastifyPluginAsync<AgentDefinitionsOpts> = async (app, { config }) => {
  app.get<{ Params: { type: string } }>(
    '/agents/definitions/:type',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            type: { type: 'string', pattern: AGENT_NAME_PATTERN },
          },
          required: ['type'],
        },
      },
    },
    async (request, reply) => {
      const { type } = request.params;

      const repoRoot = config.configDir;
      const dynamicDir = path.join(repoRoot, 'dynamic-agents');
      const staticDir = path.join(repoRoot, 'agents');
      const skillsDir = path.join(repoRoot, 'skills');

      // Locate source: dynamic-agents/{type}.md first, then agents/{type}.md
      const dynamicPath = path.join(dynamicDir, `${type}.md`);
      const staticPath = path.join(staticDir, `${type}.md`);

      let sourcePath: string | null = null;
      let isDynamic = false;

      if (await fileExists(dynamicPath)) {
        sourcePath = dynamicPath;
        // Check if it has skills in frontmatter
        const text = await fs.readFile(dynamicPath, 'utf-8');
        const { meta } = parseFrontmatter(text);
        isDynamic = Array.isArray(meta['skills']) && meta['skills'].length > 0;
      } else if (await fileExists(staticPath)) {
        sourcePath = staticPath;
        isDynamic = false;
      }

      if (!sourcePath) {
        return reply.notFound('Agent type not found');
      }

      if (isDynamic) {
        // Compile to a temp directory, read output, clean up
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-def-'));
        try {
          compileAgent(sourcePath, tmpDir, skillsDir);

          const compiledPath = path.join(tmpDir, `${type}.md`);
          const metaPath = path.join(tmpDir, `${type}.meta.json`);

          const markdown = await fs.readFile(compiledPath, 'utf-8');
          const metaRaw = await fs.readFile(metaPath, 'utf-8');

          let meta: unknown;
          try {
            meta = JSON.parse(metaRaw);
          } catch {
            throw app.httpErrors.internalServerError('Failed to parse compiled agent metadata');
          }

          return { agentType: type, markdown, meta };
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      } else {
        // Static agent: return directly with default meta
        const markdown = await fs.readFile(sourcePath, 'utf-8');
        return { agentType: type, markdown, meta: { 'access-scope': 'read-only' } };
      }
    },
  );
};

export default agentDefinitionsPlugin;
