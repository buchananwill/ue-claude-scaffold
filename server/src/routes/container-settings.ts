import type { FastifyPluginAsync } from 'fastify';
import { buildSettingsJson, buildMcpJson } from '../container-settings.js';

interface SettingsQuery {
  build?: string;
  lint?: string;
  gitSync?: string;
  readonly?: string;
}

interface McpQuery {
  chatRoom?: string;
  serverUrl?: string;
  agentName?: string;
  sessionToken?: string;
}

function toBool(val: string | undefined, defaultVal = false): boolean {
  if (val === undefined) return defaultVal;
  return val === 'true' || val === '1';
}

const containerSettingsPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { name: string }; Querystring: SettingsQuery }>(
    '/agents/:name/settings.json',
    async (request) => {
      const q = request.query as SettingsQuery;
      return buildSettingsJson({
        buildIntercept: toBool(q.build),
        cppLint: toBool(q.lint),
        gitSync: toBool(q.gitSync),
        workspaceReadonly: toBool(q.readonly),
      });
    },
  );

  app.get<{ Params: { name: string }; Querystring: McpQuery }>(
    '/agents/:name/mcp.json',
    async (request) => {
      const q = request.query as McpQuery;
      return buildMcpJson({
        chatRoom: q.chatRoom || null,
        serverUrl: q.serverUrl || '',
        agentName: q.agentName || request.params.name,
        sessionToken: q.sessionToken || '',
      });
    },
  );
};

export default containerSettingsPlugin;
