/**
 * Agent definitions route.
 *
 * GET /agents/definitions/:type — compile and return an agent definition
 * (markdown + meta.json sidecar) on demand.
 */
import * as fs from 'node:fs';
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

      if (fs.existsSync(dynamicPath)) {
        sourcePath = dynamicPath;
        // Check if it has skills in frontmatter
        const text = fs.readFileSync(dynamicPath, 'utf-8');
        const { meta } = parseFrontmatter(text);
        isDynamic = Array.isArray(meta['skills']) && meta['skills'].length > 0;
      } else if (fs.existsSync(staticPath)) {
        sourcePath = staticPath;
        isDynamic = false;
      }

      if (!sourcePath) {
        return reply.notFound(`Agent type '${type}' not found`);
      }

      if (isDynamic) {
        // Compile to a temp directory, read output, clean up
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-def-'));
        try {
          compileAgent(sourcePath, tmpDir, skillsDir);

          const compiledPath = path.join(tmpDir, `${type}.md`);
          const metaPath = path.join(tmpDir, `${type}.meta.json`);

          const markdown = fs.readFileSync(compiledPath, 'utf-8');
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

          return { agentType: type, markdown, meta };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } else {
        // Static agent: return directly with default meta
        const markdown = fs.readFileSync(sourcePath, 'utf-8');
        return { agentType: type, markdown, meta: { 'access-scope': 'read-only' } };
      }
    },
  );
};

export default agentDefinitionsPlugin;
