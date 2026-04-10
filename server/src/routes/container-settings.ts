/**
 * Container settings routes.
 *
 * Trust model: these routes run on a host-local coordination server that is
 * not exposed to the internet. Callers are Docker containers on the same
 * machine or the operator's dashboard. No additional authentication is
 * applied beyond the network boundary. The MCP route uses X-Session-Token
 * as a de-facto auth token (only the registered agent possesses it).
 */
import type { FastifyPluginAsync } from "fastify";
import { buildSettingsJson, buildMcpJson } from "../container-settings.js";
import type { SettingsJson, McpJson } from "../container-settings.js";
import { AGENT_NAME_RE } from "../branch-naming.js";

interface SettingsQuery {
  build?: string;
  lint?: string;
  jsLint?: string;
  gitSync?: string;
  readonly?: string;
}

interface McpQuery {
  chatRoom?: string;
  serverUrl?: string;
}

function toBool(val: string | undefined, defaultVal = false): boolean {
  if (val === undefined) return defaultVal;
  return val === "true" || val === "1";
}

const AGENT_NAME_PATTERN = AGENT_NAME_RE.source;

const containerSettingsPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { name: string }; Querystring: SettingsQuery }>(
    "/agents/:name/settings.json",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            name: { type: "string", pattern: AGENT_NAME_PATTERN },
          },
          required: ["name"],
        },
      },
    },
    async (request): Promise<SettingsJson> => {
      return buildSettingsJson({
        buildIntercept: toBool(request.query.build),
        cppLint: toBool(request.query.lint),
        jsLint: toBool(request.query.jsLint),
        gitSync: toBool(request.query.gitSync),
        workspaceReadonly: toBool(request.query.readonly),
      });
    },
  );

  app.get<{ Params: { name: string }; Querystring: McpQuery }>(
    "/agents/:name/mcp.json",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            name: { type: "string", pattern: AGENT_NAME_PATTERN },
          },
          required: ["name"],
        },
      },
    },
    async (request, reply): Promise<McpJson> => {
      const chatRoom = request.query.chatRoom || null;
      const serverUrl = request.query.serverUrl || "";
      const rawToken = request.headers["x-session-token"];
      const tokenStr = Array.isArray(rawToken) ? rawToken[0] : (rawToken ?? "");
      // Handle comma-joined multi-value headers (HTTP spec allows this)
      const sessionToken = tokenStr.split(",")[0].trim();

      // Validate chatRoom format if provided
      if (chatRoom && !/^[a-zA-Z0-9_-]+$/.test(chatRoom)) {
        return reply.badRequest("chatRoom must match ^[a-zA-Z0-9_-]+$");
      }

      // When chatRoom is set, serverUrl must be a valid URL
      if (chatRoom && !serverUrl) {
        return reply.badRequest(
          "serverUrl query param is required when chatRoom is set",
        );
      }

      if (serverUrl && !/^https?:\/\//.test(serverUrl)) {
        return reply.badRequest(
          "serverUrl must start with http:// or https://",
        );
      }

      // When chatRoom is set, sessionToken header is required
      if (chatRoom && !sessionToken) {
        return reply.badRequest(
          "X-Session-Token header is required when chatRoom is set",
        );
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
