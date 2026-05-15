/**
 * Context Refiner - Enhances context management by extracting and preserving
 * key facts before compression discards them, and injecting saved memory
 * to prevent "project amnesia".
 *
 * Works BEFORE context-compressor to extract and preserve important information.
 */

const { estimateTokens } = require('./context-compressor');
const config = require('./config');

// Patterns for detecting assistant conclusions
const CONCLUSION_PATTERNS = [
  /I conclude/i,
  /I recommend/i,
  /we should/i,
  /I'll use/i,
  /the best approach is/i,
  /decided to/i,
];

// Patterns for detecting user instructions
const INSTRUCTION_PATTERNS = [
  /IMPORTANT:/i,
  /\bMUST\b/,
  /\bNEVER\b/,
  /\bALWAYS\b/,
  /requirement/i,
  /constraint/i,
];

/**
 * Determine if refinement is needed based on token estimate.
 * Triggers when estimated tokens >= 80% of the compression threshold.
 *
 * @param {object} openaiRequest - OpenAI format request
 * @param {object} options - Optional: { maxTokens } to override default threshold
 * @returns {boolean}
 */
function shouldRefine(openaiRequest, options) {
  const threshold = (options && options.maxTokens) || config.contextCompressionThreshold;
  const messages = openaiRequest.messages || [];

  // Base estimate using estimateTokens (conservative: ~4 chars/token for English)
  const baseEstimate = estimateTokens(JSON.stringify(openaiRequest));

  // Content-based estimate that accounts for real API token consumption.
  // estimateTokens divides by ~4 chars/token for English, but real tokenizers
  // with chat templates, special tokens, and message formatting effectively
  // consume ~2 chars/token. We compute total content length × 2 as a more
  // realistic effective token estimate that covers template overhead.
  let totalContentChars = 0;
  for (const msg of messages) {
    if (msg.content) totalContentChars += String(msg.content).length;
    if (msg.tool_calls) totalContentChars += JSON.stringify(msg.tool_calls).length;
  }

  // Use the more generous of the two estimates
  const estimated = Math.max(baseEstimate, totalContentChars * 2);

  return estimated >= threshold * config.contextRefinerThresholdRatio;
}

/**
 * Extract key facts from messages using heuristic pattern matching.
 *
 * Priority:
 * 1. Assistant conclusions (I conclude, I recommend, we should, etc.)
 * 2. Tool call records (tool name + key parameters)
 * 3. User instructions (IMPORTANT:, MUST, NEVER, ALWAYS, etc.)
 * 4. Tool results with key data (JSON objects with name, type, version, etc.)
 *
 * @param {Array} messages - Array of OpenAI format messages
 * @returns {Array<string>} - Array of extracted fact strings
 */
function extractKeyFacts(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  const facts = [];

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Skip trivial messages
    if (isTrivial(content) && !msg.tool_calls) continue;

    // 1. Assistant conclusions
    if (msg.role === 'assistant' && content) {
      for (const pattern of CONCLUSION_PATTERNS) {
        if (pattern.test(content)) {
          facts.push(truncateFact(`[Assistant concluded] ${content.trim()}`));
          break; // One fact per message for conclusions
        }
      }
    }

    // 2. Tool call records
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const toolName = (tc.function && tc.function.name) || 'unknown';
        let argsStr = '';
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          const keyParams = Object.entries(args)
            .slice(0, 3)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ');
          argsStr = keyParams ? `(${keyParams})` : '';
        } catch (e) {
          argsStr = '';
        }
        facts.push(truncateFact(`[Tool call] ${toolName}${argsStr}`));
      }
    }

    // 3. User instructions
    if (msg.role === 'user' && content && !isTrivial(content)) {
      for (const pattern of INSTRUCTION_PATTERNS) {
        if (pattern.test(content)) {
          facts.push(truncateFact(`[User instruction] ${content.trim()}`));
          break;
        }
      }
    }

    // 4. Tool results with key data
    if (msg.role === 'tool' && content) {
      try {
        const data = JSON.parse(content);
        if (typeof data === 'object' && data !== null) {
          const keys = Object.keys(data);
          const hasKeyFields = keys.some(k =>
            ['name', 'type', 'version', 'status', 'framework', 'path'].includes(k)
          );
          if (hasKeyFields) {
            const summary = keys
              .slice(0, 5)
              .map(k => `${k}: ${JSON.stringify(data[k])}`)
              .join(', ');
            facts.push(truncateFact(`[Tool result] ${summary}`));
          }
        }
      } catch (e) {
        // Not JSON, skip
      }
    }
  }

  return facts;
}

/**
 * Inject saved facts into system prompt.
 *
 * @param {string|null} originalSystem - Original system prompt content
 * @param {Array<string>} facts - Array of fact strings
 * @returns {string} - Refined system prompt with facts injected
 */
function buildRefinedSystemPrompt(originalSystem, facts) {
  if (!facts || facts.length === 0) return originalSystem;

  // Deduplicate facts
  const uniqueFacts = [...new Set(facts)];
  const factList = uniqueFacts.map((f, i) => `${i + 1}. ${f}`).join('\n');

  if (originalSystem) {
    return `${originalSystem}\n\n[Memory - Key Facts from Previous Context]\n${factList}`;
  }
  return `[Memory - Key Facts from Previous Context]\n${factList}`;
}

/**
 * Create a summary message from extracted facts.
 *
 * @param {Array<string>} facts - Array of fact strings
 * @returns {object|null} - Message object { role, content } or null if no facts
 */
function createRefinementMessage(facts) {
  if (!facts || facts.length === 0) return null;

  const factList = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return {
    role: 'system',
    content: `[Context Refinement Summary]\n${factList}`,
  };
}

/**
 * Main entry point: check if context needs refinement, extract and save facts, inject memory.
 *
 * @param {object} openaiRequest - OpenAI format request
 * @param {string} sessionId - Session identifier
 * @param {object} memoryStore - MemoryStore instance
 * @returns {Promise<object>} - { request: modifiedRequest, refined: boolean, factsExtracted: number }
 */
async function refineContext(openaiRequest, sessionId, memoryStore) {
  // 1. Load previously saved facts from memoryStore
  let savedFacts = [];
  if (memoryStore && memoryStore.loadFacts) {
    try {
      savedFacts = await memoryStore.loadFacts(sessionId) || [];
    } catch (e) {
      savedFacts = [];
    }
  }

  // 2. If saved facts exist, inject them into the system prompt
  const messages = openaiRequest.messages || [];
  let systemContent = null;
  const otherMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent = msg.content;
    } else {
      otherMessages.push(msg);
    }
  }

  let refinedSystem = systemContent;
  if (savedFacts.length > 0) {
    refinedSystem = buildRefinedSystemPrompt(systemContent, savedFacts);
  }

  // 3. Check if refinement is needed
  let factsExtracted = 0;
  let refined = false;

  if (shouldRefine(openaiRequest)) {
    refined = true;

    // 3a. Extract key facts from current messages
    const extractedFacts = extractKeyFacts(messages);
    factsExtracted = extractedFacts.length;

    // 3b. Save extracted facts to memoryStore (append, don't overwrite)
    if (memoryStore && extractedFacts.length > 0) {
      try {
        const existingFacts = await memoryStore.loadFacts(sessionId) || [];
        const allFacts = [...existingFacts, ...extractedFacts];
        await memoryStore.saveFacts(sessionId, allFacts);
      } catch (e) {
        // Ignore save errors
      }

      // 3c. Save context summary to memoryStore
      try {
        await memoryStore.saveContext(sessionId, {
          sessionId,
          timestamp: Date.now(),
          factCount: extractedFacts.length,
          messageCount: messages.length,
        });
      } catch (e) {
        // Ignore save errors
      }
    }
  }

  // 4. Build modified request (do NOT mutate original)
  const newMessages = [];
  if (refinedSystem) {
    newMessages.push({ role: 'system', content: refinedSystem });
  }
  newMessages.push(...otherMessages);

  const modifiedRequest = {
    ...openaiRequest,
    messages: newMessages,
  };

  return {
    request: modifiedRequest,
    refined,
    factsExtracted,
  };
}

// ─── Internal helpers ───

function isTrivial(content) {
  if (!content || typeof content !== 'string') return true;
  const trimmed = content.trim();
  if (trimmed.length < 5) return true;
  // Check for common trivial patterns
  return /^(hi|hello|hey|ok|okay|sure|yes|no|thanks|thank you|got it|understood)$/i.test(trimmed);
}

function truncateFact(fact, maxLen = 200) {
  if (fact.length <= maxLen) return fact;
  return fact.substring(0, maxLen - 3) + '...';
}

module.exports = {
  refineContext,
  extractKeyFacts,
  shouldRefine,
  buildRefinedSystemPrompt,
  createRefinementMessage,
};
