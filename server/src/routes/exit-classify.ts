import type { FastifyPluginAsync } from 'fastify';
import { classifyExit, type ClassifyExitInput, type ClassifyExitResult } from '../exit-classifier.js';

const exitClassifyPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { name: string };
    Body: ClassifyExitInput;
  }>('/agents/:name/exit-classify', {
    schema: {
      params: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['name'],
      },
      // Schema must stay in sync with ClassifyExitInput in ../exit-classifier.ts
      body: {
        type: 'object',
        required: ['logTail', 'elapsedSeconds', 'outputLineCount'],
        properties: {
          logTail: { type: 'string', maxLength: 65536 },
          elapsedSeconds: { type: 'integer', minimum: 0, maximum: 86400 },
          // outputLineCount is the total line count of the full log file,
          // not the length of the logTail snippet.
          outputLineCount: { type: 'integer', minimum: 0, maximum: 10000000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request): Promise<ClassifyExitResult> => {
    // Agent name used for log correlation only — no existence check needed for this stateless endpoint
    const { name } = request.params;
    request.log.info({ agent: name }, 'exit-classify request');
    const { logTail, elapsedSeconds, outputLineCount } = request.body;
    return classifyExit({ logTail, elapsedSeconds, outputLineCount });
  });
};

export default exitClassifyPlugin;
