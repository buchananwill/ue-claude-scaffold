// Stateless computation endpoint. No auth required — relies on network isolation.
import type { FastifyPluginAsync } from 'fastify';
import AjvModule from 'ajv';
const Ajv = AjvModule.default ?? AjvModule;
import { resolveHooks, type HookResolutionInput } from '../hook-resolution.js';

const hookFlagsSchema = {
  type: 'object',
  properties: {
    buildIntercept: { type: ['boolean', 'null'] },
    cppLint: { type: ['boolean', 'null'] },
  },
  additionalProperties: false,
} as const;

const hooksPlugin: FastifyPluginAsync = async (fastify) => {
  // Disable type coercion so string values like "true" are rejected as non-boolean.
  const ajv = new (Ajv as any)({ coerceTypes: false, allErrors: true });

  fastify.setValidatorCompiler(({ schema }) => {
    return ajv.compile(schema);
  });

  fastify.post<{
    Body: HookResolutionInput;
  }>('/hooks/resolve', {
    schema: {
      body: {
        type: 'object',
        required: ['hasBuildScript'],
        properties: {
          hasBuildScript: { type: 'boolean' },
          projectHooks: hookFlagsSchema,
          teamHooks: hookFlagsSchema,
          memberHooks: hookFlagsSchema,
          cliOverride: hookFlagsSchema,
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    return resolveHooks(request.body);
  });
};

export default hooksPlugin;
