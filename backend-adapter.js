/**
 * backend-adapter.js — Multi-backend abstraction layer
 *
 * Unifies communication with LM Studio and llama.cpp servers,
 * handling their differences in request preparation, response
 * normalization, error parsing, and endpoint URLs.
 */

// ─── stop_type → finish_reason mapping for llama.cpp ───
const STOP_TYPE_MAP = {
  eos: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  word: 'stop',
};

/**
 * Create an LM Studio backend adapter
 */
function createLMStudioBackend(config) {
  const baseUrl = config.baseUrl;

  return {
    getBaseUrl() {
      return baseUrl;
    },

    getChatCompletionsUrl() {
      return `${baseUrl}/v1/chat/completions`;
    },

    getModelsUrl() {
      return `${baseUrl}/v1/models`;
    },

    getHealthUrl() {
      return `${baseUrl}/v1/models`;
    },

    prepareRequest(openaiRequest) {
      return openaiRequest;
    },

    parseResponse(response) {
      return response;
    },

    parseError(error) {
      return {
        message: error.message || error.error || String(error),
        type: error.type || 'unknown',
      };
    },

    getName() {
      return 'LM Studio';
    },

    isStreamFormatDifferent() {
      return false;
    },
  };
}

/**
 * Create a llama.cpp backend adapter
 */
function createLlamaCppBackend(config) {
  const baseUrl = config.baseUrl;
  const cachePrompt = config.cache_prompt;
  const reasoningFormat = config.reasoning_format;

  return {
    getBaseUrl() {
      return baseUrl;
    },

    getChatCompletionsUrl() {
      return `${baseUrl}/v1/chat/completions`;
    },

    getModelsUrl() {
      return `${baseUrl}/v1/models`;
    },

    getHealthUrl() {
      return `${baseUrl}/health`;
    },

    prepareRequest(openaiRequest) {
      const prepared = { ...openaiRequest };

      // If tools are present, enable llama.cpp tool call parsing
      if (Array.isArray(openaiRequest.tools) && openaiRequest.tools.length > 0) {
        prepared.parse_tool_calls = true;
      }

      // Forward cache_prompt from config if provided
      if (cachePrompt !== undefined) {
        prepared.cache_prompt = cachePrompt;
      }

      // Forward reasoning_format from config if provided
      if (reasoningFormat !== undefined) {
        prepared.reasoning_format = reasoningFormat;
      }

      return prepared;
    },

    parseResponse(response) {
      const parsed = { ...response };
      const metadata = {};

      // Preserve timings in metadata
      if (parsed.timings !== undefined) {
        metadata.timings = parsed.timings;
        delete parsed.timings;
      }

      // Preserve truncated in metadata
      if (parsed.truncated !== undefined) {
        metadata.truncated = parsed.truncated;
      }

      // Map stop_type → finish_reason for each choice
      const stopType = parsed.stop_type;
      if (stopType !== undefined) {
        delete parsed.stop_type;
      }

      if (Array.isArray(parsed.choices)) {
        for (const choice of parsed.choices) {
          // Truncated response overrides finish_reason to 'length'
          if (parsed.truncated === true) {
            choice.finish_reason = 'length';
          } else if (stopType !== undefined && (choice.finish_reason === null || choice.finish_reason === undefined)) {
            choice.finish_reason = STOP_TYPE_MAP[stopType] || 'stop';
          } else if (stopType !== undefined && choice.finish_reason !== null && choice.finish_reason !== undefined) {
            // If finish_reason is already set but we have stop_type, prefer the mapped value
            choice.finish_reason = STOP_TYPE_MAP[stopType] || choice.finish_reason;
          }
        }
      }

      // Attach metadata if we have any
      if (Object.keys(metadata).length > 0) {
        parsed._llamacpp_metadata = metadata;
      }

      return parsed;
    },

    parseError(error) {
      return {
        message: error.error || error.message || String(error),
        type: error.code ? String(error.code) : (error.type || 'unknown'),
      };
    },

    getName() {
      return 'llama.cpp';
    },

    isStreamFormatDifferent() {
      return true;
    },
  };
}

/**
 * Factory function to create a backend adapter
 * @param {string} type - 'lmstudio' or 'llamacpp'
 * @param {object} config - { baseUrl, cache_prompt?, reasoning_format?, timeout? }
 * @returns {object} Backend adapter with unified interface
 */
function createBackend(type, config) {
  switch (type) {
    case 'lmstudio':
      return createLMStudioBackend(config);
    case 'llamacpp':
      return createLlamaCppBackend(config);
    default:
      throw new Error(`Unsupported backend type: ${type}`);
  }
}

module.exports = { createBackend };
