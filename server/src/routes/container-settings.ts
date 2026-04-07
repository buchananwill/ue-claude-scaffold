/**
 * Container settings routes.
 *
 * Trust model: these routes run on a host-local coordination server that is
 * not exposed to the internet. Callers are Docker containers on the same
 * machine or the operator's dashboard. No additional authentication is
 * applied beyond the network boundary. The MCP route uses X-Session-Token
 * as a de-facto auth token (only the registered agent possesses it).
 */
import type { FastifyPluginAsync } from 'fastify';
import { buildSettingsJson, buildMcpJson } from '../container-settings.js';
import type { SettingsJson, McpJson } from '../container-settings.js';
import { AGENT_NAME_RE } from '../branch-naming.js';

interface SettingsQuery {
  build?: string;
  lint?: string;
  gitSync?: string;
  readonly?: string;
}

interface McpQuery {
  chatRoom?: string;
  serverUrl?: string;
}

function toBool(val: string | undefined, defaultVal = false): boolean {
  if (val === undefined) return defaultVal;
  return val === 'true' || val === '1';
}

const AGENT_NAME_PATTERN = AGENT_NAME_RE.source;

const containerSettingsPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { name: string }; Querystring: SettingsQuery }>(
    '/agents/:name/settings.json',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: AGENT_NAME_PATTERN },
          },
          required: ['name'],
        },
      },
    },
    async (request): Promise<SettingsJson> => {
      return buildSettingsJson({
        buildIntercept: toBool(request.query.build),
        cppLint: toBool(request.query.lint),
        gitSync: toBool(request.query.gitSync),
        workspaceReadonly: toBool(request.query.readonly),
      });
    },
  );

  app.get<{ Params: { name: string }; Querystring: McpQuery }>(
    '/agents/:name/mcp.json',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: AGENT_NAME_PATTERN },
          },
          required: ['name'],
        },
      },
    },
    async (request, reply): Promise<McpJson> => {
      const chatRoom = request.query.chatRoom || null;
      const serverUrl = request.query.serverUrl || '';
      const sessionToken = (request.headers['x-session-token'] as string) || '';

      // When chatRoom is set, serverUrl must be non-empty
      if (chatRoom && !serverUrl) {
        return reply.badRequest('serverUrl query param is required when chatRoom is set');
      }

      // When chatRoom is set, sessionToken header is required
      if (chatRoom && !sessionToken) {
        return reply.badRequest('X-Session-Token header is required when chatRoom is set');
      }

      return buildMcpJson({
        chatRoom,
        serverUrl,
        agentName: request.params.name,
        sessionToken,
      });
    },
  );
};

export default containerSettingsPlugin;
