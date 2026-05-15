/**
 * 上下文压缩器 - 管理 token 预算，防止超出本地模型的上下文窗口
 *
 * 功能：
 * - 缩短工具描述到核心信息
 * - 移除 schema 中可选/不常用参数
 * - 摘要旧对话轮次
 * - 根据上下文窗口限制发送的工具数量
 */

const config = require('./config');

function log(...args) {
  if (config.debugLogging) {
    console.log('[上下文压缩]', ...args);
  }
}

/**
 * 带诊断报告的上下文压缩
 */
function compressContextWithReport(openaiRequest, diag) {
  const result = compressContext(openaiRequest);

  // 收集诊断信息
  const messages = openaiRequest.messages || [];
  const systemMsg = messages.find((m) => m.role === 'system');
  const tools = openaiRequest.tools || [];
  const resultMessages = result.messages || [];
  const resultTools = result.tools || [];

  const beforeTokens = estimateTokens(JSON.stringify(openaiRequest));
  const afterTokens = estimateTokens(JSON.stringify(result));
  const savedTokens = beforeTokens - afterTokens;

  const toolsBefore = tools.length;
  const toolsAfter = resultTools.length;
  const msgsBefore = messages.length;
  const msgsAfter = resultMessages.length;

  diag.phase('上下文压缩', `消息 ${msgsBefore}→${msgsAfter}, 工具 ${toolsBefore}→${toolsAfter}`);
  diag.stat('请求估算Token', beforeTokens);
  diag.stat('压缩后Token', afterTokens);

  if (savedTokens > 0 && beforeTokens > 0) {
    diag.stat('节省Token', `${savedTokens} (${Math.round(savedTokens / beforeTokens * 100)}%)`);
  }

  // 检测是否超阈值触发了压缩
  if (msgsAfter < msgsBefore) {
    const removed = msgsBefore - msgsAfter;
    diag.issue('上下文压缩器', `上下文超出阈值，移除了 ${removed} 条旧消息并生成摘要`, 'warn');
    diag.fix('上下文压缩器', `${msgsBefore}条消息`, `${msgsAfter}条消息+摘要`, `压缩了 ${removed} 条旧消息到系统提示摘要中`);
  }

  if (toolsAfter < toolsBefore) {
    const removed = toolsBefore - toolsAfter;
    diag.issue('上下文压缩器', `工具数量 ${toolsBefore} 超过限制 ${config.contextMaxTools}，裁剪了 ${removed} 个`, 'warn');
    diag.fix('上下文压缩器', `${toolsBefore}个工具`, `${toolsAfter}个工具`, `裁剪了 ${removed} 个低优先级工具`);
  }

  // 检测工具描述是否被截断
  let descTruncated = 0;
  for (const tool of resultTools) {
    const func = tool.function || tool;
    const desc = func.description || '';
    if (desc.endsWith('...')) {
      descTruncated++;
    }
  }
  if (descTruncated > 0) {
    diag.fix('上下文压缩器', `${descTruncated}个长描述`, '截断到限制长度', `截断了 ${descTruncated} 个工具的过长描述 (>${config.contextToolDescriptionMaxLength}字)`);
  }

  if (savedTokens <= 0 && msgsAfter === msgsBefore && toolsAfter === toolsBefore) {
    diag.phase('上下文压缩', '无需压缩，上下文在阈值内');
  }

  return result;
}

/**
 * 估算文本的 token 数量（简单估算：中文约1.5字/token，英文约4字符/token）
 */
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = JSON.stringify(text);

  // 中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  // 非中文字符数
  const otherChars = text.length - chineseChars;

  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 压缩工具定义
 * - 截断过长的描述
 * - 移除 schema 中的 description 字段
 * - 移除可选参数（非 required）
 * - 简化嵌套结构
 */
function compressTools(tools) {
  if (!tools || !Array.isArray(tools)) return tools;

  // 如果工具数未超限，只做描述压缩
  if (tools.length <= config.contextMaxTools) {
    return tools.map((tool) => compressSingleTool(tool));
  }

  // 工具数超限，需要裁剪
  log(`工具数 ${tools.length} 超过限制 ${config.contextMaxTools}，进行裁剪`);

  // 保留所有工具，但优先压缩后面的工具
  const prioritized = tools.map((tool, index) => ({
    tool,
    index,
    // 优先保留靠前的工具（通常更重要）
    priority: tools.length - index,
  }));

  // 按优先级排序，取前 N 个
  prioritized.sort((a, b) => b.priority - a.priority);
  const selected = prioritized.slice(0, config.contextMaxTools);

  // 按原始顺序返回
  selected.sort((a, b) => a.index - b.index);

  return selected.map((item) => compressSingleTool(item.tool));
}

/**
 * 压缩单个工具定义
 */
function compressSingleTool(tool) {
  const compressed = { ...tool };

  // OpenAI 格式的工具
  if (compressed.function) {
    compressed.function = { ...compressed.function };

    // 截断描述
    if (compressed.function.description && compressed.function.description.length > config.contextToolDescriptionMaxLength) {
      compressed.function.description = compressed.function.description
        .substring(0, config.contextToolDescriptionMaxLength - 3) + '...';
    }

    // 简化参数 schema
    if (compressed.function.parameters) {
      compressed.function.parameters = compressSchema(compressed.function.parameters);
    }
  }

  // Anthropic 格式的工具
  if (compressed.input_schema) {
    // 截断描述
    if (compressed.description && compressed.description.length > config.contextToolDescriptionMaxLength) {
      compressed.description = compressed.description
        .substring(0, config.contextToolDescriptionMaxLength - 3) + '...';
    }

    compressed.input_schema = compressSchema(compressed.input_schema);
  }

  return compressed;
}

/**
 * 压缩 JSON Schema
 * - 移除 description 字段
 * - 移除非 required 的属性（激进模式下）
 * - 简化嵌套对象为一行描述
 */
function compressSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const compressed = {
    type: schema.type || 'object',
  };

  if (schema.properties) {
    compressed.properties = {};
    const required = schema.required || [];

    for (const [key, value] of Object.entries(schema.properties)) {
      // 如果参数是 required 或者属性数量不多，保留
      if (required.includes(key) || Object.keys(schema.properties).length <= 5) {
        compressed.properties[key] = compressSchemaProperty(value);
      } else {
        // 可选参数只保留类型信息
        compressed.properties[key] = { type: value.type || 'string' };
      }
    }

    // 保留 required 列表
    if (required.length > 0) {
      compressed.required = required;
    }
  }

  // 保留 enum 值
  if (schema.enum) {
    compressed.enum = schema.enum;
  }

  return compressed;
}

/**
 * 压缩单个 schema 属性
 */
function compressSchemaProperty(prop) {
  if (!prop || typeof prop !== 'object') return prop;

  const compressed = { type: prop.type || 'string' };

  // 保留枚举值（对工具调用很关键）
  if (prop.enum) compressed.enum = prop.enum;

  // 保留默认值
  if (prop.default !== undefined) compressed.default = prop.default;

  // 简化嵌套对象
  if (prop.type === 'object' && prop.properties) {
    compressed.type = 'object';
    compressed.properties = {};
    for (const [key, value] of Object.entries(prop.properties)) {
      compressed.properties[key] = { type: value.type || 'string' };
    }
  }

  // 简化数组
  if (prop.type === 'array' && prop.items) {
    compressed.type = 'array';
    compressed.items = { type: prop.items.type || 'string' };
  }

  return compressed;
}

/**
 * 摘要旧对话轮次
 * 当消息列表过长时，将旧消息压缩为摘要
 *
 * 重要：保持 tool_calls 和 tool result 的配对关系
 * 不能把 assistant(tool_calls) 和对应的 role:tool 消息拆开
 */
function compressMessages(messages, systemPrompt) {
  if (!messages || !Array.isArray(messages)) return { messages, systemPrompt };

  // 估算当前 token 总量
  let totalTokens = estimateTokens(systemPrompt || '');
  for (const msg of messages) {
    // 正确处理 null content（assistant 消息带 tool_calls 时常见）
    const contentStr = msg.content === null ? '' : String(msg.content || '');
    totalTokens += estimateTokens(contentStr);
    // 也计算 role、name、tool_call_id 等元数据的 token
    totalTokens += estimateTokens(msg.role || '');
    if (msg.name) totalTokens += estimateTokens(msg.name);
    if (msg.tool_call_id) totalTokens += estimateTokens(msg.tool_call_id);
    if (msg.tool_calls) {
      totalTokens += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }

  log('当前估算 token 数:', totalTokens, '阈值:', config.contextCompressionThreshold);

  if (totalTokens <= config.contextCompressionThreshold) {
    return { messages, systemPrompt };
  }

  // 需要压缩 - 保留最近的消息，摘要旧消息
  log('超出阈值，开始压缩消息');

  // 找到安全的切割点：不能拆开 assistant(tool_calls) + role:tool 的配对
  const keepCount = Math.max(Math.ceil(messages.length * 0.7), 4);
  let splitIndex = Math.max(0, messages.length - keepCount); // v3: 防止负数

  // 向前调整切割点，确保不在 tool call 链中间切割
  // 从 splitIndex 开始向前找，确保不是 role:tool 消息
  while (splitIndex > 0) {
    const msg = messages[splitIndex];
    if (msg.role === 'tool') {
      // 这是 tool result，需要找到对应的 assistant(tool_calls)
      // 向前移动切割点
      splitIndex--;
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      // assistant 带有 tool_calls，检查前面是否有对应的 tool results
      // 需要保留这组配对，向前移动
      splitIndex--;
    } else {
      // 安全的切割点
      break;
    }
  }

  // v6修复: 确保至少保留4条消息，如果总消息数不足4条则不压缩
  const minRetain = 4;
  if (messages.length <= minRetain) {
    log('消息数不足，跳过压缩:', messages.length, '<=', minRetain);
    return { messages, systemPrompt };
  }
  splitIndex = Math.min(splitIndex, messages.length - minRetain);
  splitIndex = Math.max(0, splitIndex); // 确保不为负

  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  // 生成旧消息摘要
  const summary = generateSummary(oldMessages);

  // 将摘要合并到系统提示中
  const compressedSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n[之前对话的摘要]\n${summary}`
    : `[之前对话的摘要]\n${summary}`;

  log('压缩完成，消息数:', messages.length, '→', recentMessages.length, '+ 摘要');

  return {
    messages: recentMessages,
    systemPrompt: compressedSystemPrompt,
  };
}

/**
 * 生成消息列表的摘要
 */
function generateSummary(messages) {
  const summaries = [];

  for (const msg of messages) {
    const role = msg.role || 'unknown';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join(' ');
    }

    // 截断过长的内容
    if (content.length > 200) {
      content = content.substring(0, 200) + '...';
    }

    // 记录工具调用信息
    if (msg.tool_calls) {
      const toolNames = msg.tool_calls.map((tc) => tc.function?.name || 'unknown').join(', ');
      content += ` [调用工具: ${toolNames}]`;
    }

    // 记录工具结果
    if (msg.role === 'tool') {
      content = `工具结果: ${content.substring(0, 100)}`;
    }

    if (content.trim()) {
      summaries.push(`[${role}] ${content}`);
    }
  }

  return summaries.join('\n');
}

/**
 * 主入口：对 OpenAI 格式的完整请求进行上下文压缩
 */
function compressContext(openaiRequest) {
  let { messages, tools, systemPrompt } = {
    messages: openaiRequest.messages,
    tools: openaiRequest.tools,
    systemPrompt: undefined,
  };

  // 提取系统提示
  const systemMsg = messages.find((m) => m.role === 'system');
  if (systemMsg) {
    systemPrompt = systemMsg.content;
    messages = messages.filter((m) => m.role !== 'system');
  }

  // 压缩工具
  if (tools) {
    tools = compressTools(tools);
  }

  // 压缩消息
  const compressed = compressMessages(messages, systemPrompt);

  // 重建消息列表
  const newMessages = [];
  if (compressed.systemPrompt) {
    newMessages.push({ role: 'system', content: compressed.systemPrompt });
  }
  newMessages.push(...compressed.messages);

  return {
    ...openaiRequest,
    messages: newMessages,
    tools: tools || openaiRequest.tools,
  };
}

module.exports = {
  compressContext,
  compressContextWithReport,
  compressTools,
  compressMessages,
  estimateTokens,
};
