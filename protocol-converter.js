/**
 * 协议转换器 - Anthropic Messages API ↔ OpenAI Chat Completions API 双向转换
 *
 * 核心转换逻辑：
 * - Anthropic tools[].input_schema → OpenAI tools[].function.parameters
 * - Anthropic content[].type="tool_use" → OpenAI message.tool_calls[]
 * - Anthropic content[].type="tool_result" → OpenAI role:"tool" 消息
 * - Anthropic tool_use_id → OpenAI tool_call_id
 * - Anthropic stop_reason:"tool_use" ↔ OpenAI finish_reason:"tool_calls"
 * - Anthropic 解析后的对象参数 → OpenAI function.arguments JSON 字符串
 * - Anthropic is_error:true → OpenAI 错误内容格式化
 */

const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// ─── 日志辅助 ───
function log(...args) {
  if (config.debugLogging) {
    console.log('[协议转换]', ...args);
  }
}

// ═══════════════════════════════════════════════════════
//  Anthropic → OpenAI 转换
// ═══════════════════════════════════════════════════════

/**
 * 转换工具定义：Anthropic 格式 → OpenAI 格式
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type:"function", function: { name, description, parameters } }
 */
function convertToolsToOpenAI(anthropicTools) {
  if (!anthropicTools || !Array.isArray(anthropicTools)) return undefined;

  return anthropicTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * 转换消息列表：Anthropic 格式 → OpenAI 格式
 *
 * Anthropic 消息模型：
 *   - system 是顶级字段，不在 messages 里
 *   - content 可以是字符串或内容块数组
 *   - tool_result 作为 assistant/user 消息中的内容块
 *
 * OpenAI 消息模型：
 *   - system 是 role:"system" 的消息
 *   - tool_calls 在 assistant 消息的顶级字段
 *   - tool 结果是 role:"tool" 的独立消息
 */
function convertMessagesToOpenAI(anthropicMessages, systemPrompt) {
  const openaiMessages = [];

  // 添加系统提示（如果有）
  if (systemPrompt) {
    openaiMessages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  if (!anthropicMessages || !Array.isArray(anthropicMessages)) {
    return openaiMessages;
  }

  for (const msg of anthropicMessages) {
    const converted = convertSingleMessageToOpenAI(msg);
    openaiMessages.push(...converted);
  }

  return openaiMessages;
}

/**
 * 转换单条 Anthropic 消息 → 一条或多条 OpenAI 消息
 *
 * 返回数组是因为一条 Anthropic 的 user 消息可能包含 tool_result，
 * 需要拆分为 assistant (带 tool_calls) + role:tool 消息
 */
function convertSingleMessageToOpenAI(msg) {
  const results = [];

  // 如果 content 是纯字符串
  if (typeof msg.content === 'string') {
    results.push({
      role: msg.role,
      content: msg.content,
    });
    return results;
  }

  // 如果 content 是 null/undefined（带 tool_calls 的 assistant 消息）
  if (msg.content === null || msg.content === undefined) {
    results.push({
      role: msg.role,
      content: msg.role === 'assistant' ? null : '',
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });
    return results;
  }

  // 如果 content 是内容块数组
  if (Array.isArray(msg.content)) {
    const textParts = [];
    const toolUseParts = [];
    const toolResultParts = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseParts.push(block);
      } else if (block.type === 'tool_result') {
        toolResultParts.push(block);
      }
      // 忽略其他类型（如 thinking）
    }

    // ── 处理 assistant 消息（可能包含 tool_use） ──
    if (msg.role === 'assistant') {
      const assistantMsg = { role: 'assistant' };

      // 文本内容
      const textContent = textParts.join('\n').trim();
      if (textContent) {
        assistantMsg.content = textContent;
      } else {
        // OpenAI 要求 content 至少为 null（当有 tool_calls 时可以为 null）
        assistantMsg.content = toolUseParts.length > 0 ? null : '';
      }

      // 工具调用
      if (toolUseParts.length > 0) {
        assistantMsg.tool_calls = toolUseParts.map((tu) => ({
          id: tu.id || uuidv4(),
          type: 'function',
          function: {
            name: tu.name,
            arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
          },
        }));
      }

      results.push(assistantMsg);
    }

    // ── 处理 user 消息（可能包含 tool_result） ──
    if (msg.role === 'user') {
      if (toolResultParts.length > 0) {
        // tool_result 需要转换为 role:"tool" 消息
        // 但在 Anthropic 中，tool_result 嵌在 user 消息里
        // 对应的 tool_use 在之前的 assistant 消息中

        for (const tr of toolResultParts) {
          let toolContent = '';
          if (Array.isArray(tr.content)) {
            // tool_result 的 content 也可能是内容块数组
            toolContent = tr.content
              .map((b) => {
                if (b.type === 'text') return b.text;
                if (typeof b === 'string') return b;
                return JSON.stringify(b);
              })
              .join('\n');
          } else if (typeof tr.content === 'string') {
            toolContent = tr.content;
          } else if (tr.content !== undefined) {
            toolContent = JSON.stringify(tr.content);
          }

          // 如果标记为错误，在内容中标识
          if (tr.is_error) {
            toolContent = `[ERROR] ${toolContent}`;
          }

          results.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: toolContent,
          });
        }

        // 如果 user 消息中同时有文本内容，也添加进来
        if (textParts.length > 0) {
          // 将文本内容作为 user 消息添加（放在 tool 消息之后）
          results.push({
            role: 'user',
            content: textParts.join('\n').trim(),
          });
        }
      } else {
        // 纯文本 user 消息
        results.push({
          role: 'user',
          content: textParts.join('\n').trim(),
        });
      }
    }
  }

  return results;
}

/**
 * 将完整的 Anthropic Messages API 请求转换为 OpenAI Chat Completions API 请求
 */
function convertAnthropicToOpenAI(anthropicRequest) {
  log('转换 Anthropic → OpenAI 请求');

  const openaiRequest = {
    model: config.modelOverride || anthropicRequest.model || config.defaultModel,
    messages: convertMessagesToOpenAI(
      anthropicRequest.messages,
      typeof anthropicRequest.system === 'string'
        ? anthropicRequest.system
        : Array.isArray(anthropicRequest.system)
          ? anthropicRequest.system.map((s) => s.text || '').join('\n')
          : undefined
    ),
    temperature: anthropicRequest.tools
      ? config.toolCallTemperature
      : (anthropicRequest.temperature ?? 0.7),
    max_tokens: anthropicRequest.max_tokens || config.toolCallMaxTokens,
    stream: anthropicRequest.stream || false,
  };

  // 转换工具定义
  if (anthropicRequest.tools && anthropicRequest.tools.length > 0) {
    openaiRequest.tools = convertToolsToOpenAI(anthropicRequest.tools);
    // 启用工具调用选择模式
    openaiRequest.tool_choice = anthropicRequest.tool_choice
      ? convertToolChoiceToOpenAI(anthropicRequest.tool_choice)
      : 'auto';
  }

  // 处理 stop_sequences
  if (anthropicRequest.stop_sequences && anthropicRequest.stop_sequences.length > 0) {
    openaiRequest.stop = anthropicRequest.stop_sequences;
  }

  // top_p 和其他参数
  if (anthropicRequest.top_p !== undefined) openaiRequest.top_p = anthropicRequest.top_p;
  // 注意: top_k 不是 OpenAI Chat Completions API 的合法参数，不转换

  log('转换完成，OpenAI 消息数:', openaiRequest.messages.length);
  return openaiRequest;
}

/**
 * 转换工具选择参数
 */
function convertToolChoiceToOpenAI(anthropicToolChoice) {
  if (typeof anthropicToolChoice === 'string') {
    switch (anthropicToolChoice) {
      case 'auto': return 'auto';
      case 'any': return 'required';
      case 'none': return 'none';
      default: return 'auto';
    }
  }
  if (anthropicToolChoice.type === 'tool') {
    return {
      type: 'function',
      function: { name: anthropicToolChoice.name },
    };
  }
  return 'auto';
}

// ═══════════════════════════════════════════════════════
//  OpenAI → Anthropic 转换
// ═══════════════════════════════════════════════════════

/**
 * 将 OpenAI Chat Completions 响应转换为 Anthropic Messages API 响应
 */
function convertOpenAIToAnthropic(openaiResponse, originalModel) {
  log('转换 OpenAI → Anthropic 响应');

  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    return createAnthropicErrorResponse('LM Studio 返回了空响应', originalModel);
  }

  const message = choice.message || {};
  const content = [];
  const model = originalModel || openaiResponse.model || config.defaultModel;

  // 处理文本内容
  if (message.content) {
    content.push({
      type: 'text',
      text: message.content,
    });
  }

  // 处理工具调用
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let parsedArgs = {};
      if (tc.function?.arguments) {
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          // JSON 解析失败，保留原始字符串
          parsedArgs = { _raw_arguments: tc.function.arguments };
        }
      }

      content.push({
        type: 'tool_use',
        id: tc.id || uuidv4(),
        name: tc.function?.name || 'unknown',
        input: parsedArgs,
      });
    }
  }

  // 如果 content 为空，添加一个空文本块
  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    });
  }

  // 确定 stop_reason
  const stopReason = convertFinishReason(choice.finish_reason, message.tool_calls);

  const anthropicResponse = {
    id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };

  log('转换完成，stop_reason:', stopReason, '内容块数:', content.length);
  return anthropicResponse;
}

/**
 * 转换 finish_reason → stop_reason
 *
 * 重要：finish_reason=length 表示响应被截断，必须保留为 max_tokens
 * 不能因为有 tool_calls 就覆盖为 tool_use，否则 OpenClaw 会执行不完整的工具调用
 */
function convertFinishReason(finishReason, toolCalls) {
  // length 优先级最高：表示响应被截断，必须告知客户端
  if (finishReason === 'length') return 'max_tokens';

  if (toolCalls && toolCalls.length > 0) {
    return 'tool_use';
  }
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

/**
 * 创建 Anthropic 格式的错误响应
 */
function createAnthropicErrorResponse(errorMsg, model) {
  return {
    id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `[适配器错误] ${errorMsg}`,
      },
    ],
    model: model || config.defaultModel,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

/**
 * 创建 Anthropic 格式的流式事件
 */
function createStreamEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ═══════════════════════════════════════════════════════
//  流式响应转换
// ═══════════════════════════════════════════════════════

/**
 * 将 OpenAI 流式 chunk 转换为 Anthropic 流式事件
 *
 * OpenAI 流式格式：
 *   choices[0].delta.content → 文本内容
 *   choices[0].delta.tool_calls → 工具调用增量
 *   choices[0].finish_reason → 结束原因
 *
 * Anthropic 流式格式：
 *   message_start → 消息开始（含元数据）
 *   content_block_start → 内容块开始
 *   content_block_delta → 内容块增量
 *   content_block_stop → 内容块结束
 *   message_delta → 消息级增量（stop_reason）
 *   message_stop → 消息结束
 */
class StreamConverter {
  constructor(model) {
    this.model = model;
    this.messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    this.currentContentBlockIndex = 0;
    this.hasStartedMessage = false;
    this.hasStartedTextBlock = false;
    this.hasStartedToolBlocks = new Map(); // tool_call_id → blockIndex
    this.textBuffer = ''; // 缓冲文本内容
    this.toolCallBuffers = new Map(); // tool_call_index → { id, name, arguments }
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.toolCallsDetected = false;
    this.hasFinished = false;
  }

  /**
   * 处理 OpenAI 流式 chunk，返回 Anthropic 格式的事件字符串数组
   */
  processChunk(chunk) {
    const events = [];

    try {
      const choice = chunk.choices?.[0];
      if (!choice) return events;

      const delta = choice.delta || {};

      // ── 首个 chunk：发送 message_start ──
      if (!this.hasStartedMessage) {
        this.hasStartedMessage = true;
        events.push(
          createStreamEvent('message_start', {
            type: 'message_start',
            message: {
              id: this.messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: this.model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        );
      }

      // ── 处理文本内容增量 ──
      if (delta.content) {
        // 累积文本到缓冲区（用于 buildFinalResponse fallback）
        this.textBuffer += delta.content;

        if (!this.hasStartedTextBlock) {
          this.hasStartedTextBlock = true;
          events.push(
            createStreamEvent('content_block_start', {
              type: 'content_block_start',
              index: this.currentContentBlockIndex,
              content_block: { type: 'text', text: '' },
            })
          );
        }

        events.push(
          createStreamEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.currentContentBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          })
        );
      }

      // ── 处理工具调用增量 ──
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;

          // 初始化工具调用缓冲
          if (!this.toolCallBuffers.has(tcIndex)) {
            // 如果之前有文本块，先关闭它
            if (this.hasStartedTextBlock) {
              events.push(
                createStreamEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: this.currentContentBlockIndex,
                })
              );
              this.currentContentBlockIndex++;
              this.hasStartedTextBlock = false;
            }

            this.toolCallBuffers.set(tcIndex, {
              id: tc.id || uuidv4(),
              name: tc.function?.name || '',
              arguments: '',
            });

            const blockIndex = this.currentContentBlockIndex + tcIndex;
            this.hasStartedToolBlocks.set(tcIndex, blockIndex);

            // 发送 tool_use 内容块开始事件
            events.push(
              createStreamEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id || this.toolCallBuffers.get(tcIndex).id,
                  name: tc.function?.name || '',
                  input: {},
                },
              })
            );
          }

          // 追加工具调用参数
          const buffer = this.toolCallBuffers.get(tcIndex);
          if (tc.function?.arguments) {
            buffer.arguments += tc.function.arguments;
          }
          if (tc.function?.name && !buffer.name) {
            buffer.name = tc.function.name;
          }

          // 发送 input_json_delta 事件
          if (tc.function?.arguments) {
            const blockIndex = this.hasStartedToolBlocks.get(tcIndex);
            events.push(
              createStreamEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: tc.function.arguments,
                },
              })
            );
          }
        }
        this.toolCallsDetected = true;
      }

      // ── 处理结束信号 ──
      if (choice.finish_reason) {
        // 关闭文本块
        if (this.hasStartedTextBlock) {
          events.push(
            createStreamEvent('content_block_stop', {
              type: 'content_block_stop',
              index: this.currentContentBlockIndex,
            })
          );
          this.currentContentBlockIndex++;
          this.hasStartedTextBlock = false;
        }

        // 关闭所有工具调用块
        for (const [tcIndex, blockIndex] of this.hasStartedToolBlocks) {
          events.push(
            createStreamEvent('content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            })
          );
        }

        // 确定 stop_reason
        const stopReason = convertFinishReason(
          choice.finish_reason,
          // 只有 finish_reason 不是 length 时，才用 toolCallsDetected 判断
          choice.finish_reason !== 'length' && this.toolCallsDetected ? [{}] : null
        );

        // 发送 message_delta 和 message_stop
        events.push(
          createStreamEvent('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              output_tokens: this.outputTokens || (choice.finish_reason ? 1 : 0),
            },
          })
        );

        events.push(
          createStreamEvent('message_stop', {
            type: 'message_stop',
          })
        );
      }
    } catch (err) {
      console.error('[流式转换] 处理 chunk 出错:', err.message);
    }

    return events;
  }

  /**
   * 生成最终的完整 Anthropic 响应（用于非流式 fallback）
   */
  buildFinalResponse() {
    const content = [];

    if (this.textBuffer) {
      content.push({ type: 'text', text: this.textBuffer });
    }

    for (const [, buffer] of this.toolCallBuffers) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(buffer.arguments);
      } catch {
        parsedArgs = { _raw_arguments: buffer.arguments };
      }
      content.push({
        type: 'tool_use',
        id: buffer.id,
        name: buffer.name,
        input: parsedArgs,
      });
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content,
      model: this.model,
      stop_reason: this.toolCallsDetected ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    };
  }
}

module.exports = {
  convertToolsToOpenAI,
  convertMessagesToOpenAI,
  convertSingleMessageToOpenAI,
  convertAnthropicToOpenAI,
  convertToolChoiceToOpenAI,
  convertOpenAIToAnthropic,
  convertFinishReason,
  createAnthropicErrorResponse,
  createStreamEvent,
  StreamConverter,
};
