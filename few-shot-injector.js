/**
 * Few-Shot 注入器 - 自动生成工具调用示例并注入系统提示
 *
 * 功能：
 * - 根据工具定义自动生成调用示例
 * - 按模型家族适配不同格式（Hermes、Qwen、ChatML 等）
 * - 注入示例到系统提示中
 * - 限制示例数量，避免占用过多上下文
 */

const config = require('./config');

function log(...args) {
  if (config.debugLogging) {
    console.log('[Few-Shot注入]', ...args);
  }
}

/**
 * 检测模型家族
 */
function detectModelFamily(modelName) {
  if (!modelName) return 'generic';

  const lower = modelName.toLowerCase();

  if (lower.includes('hermes') || lower.includes('teknium')) return 'hermes';
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
  if (lower.includes('phi')) return 'phi';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('yi')) return 'yi';
  if (lower.includes('chatml')) return 'chatml';

  return 'generic';
}

/**
 * 为单个工具生成示例
 */
function generateToolExample(tool, family) {
  const funcDef = tool.function || tool;
  const name = funcDef.name || 'unknown';
  const params = funcDef.parameters || funcDef.input_schema || { properties: {} };

  // 生成示例参数值
  const exampleArgs = generateExampleArgs(params);

  return {
    name,
    args: exampleArgs,
  };
}

/**
 * 根据 JSON Schema 生成示例参数值
 */
function generateExampleArgs(schema) {
  if (!schema || !schema.properties) return {};

  const args = {};
  const required = schema.required || [];

  for (const [key, prop] of Object.entries(schema.properties)) {
    // 只为 required 字段生成示例（减少噪声）
    if (!required.includes(key) && Object.keys(schema.properties).length > 3) continue;

    args[key] = generateExampleValue(prop);
  }

  return args;
}

/**
 * 根据属性类型生成示例值
 */
function generateExampleValue(prop) {
  if (!prop) return 'example';

  // 优先使用 enum 的第一个值
  if (prop.enum && prop.enum.length > 0) return prop.enum[0];

  // 优先使用 default
  if (prop.default !== undefined) return prop.default;

  // 优先使用 examples
  if (prop.examples && prop.examples.length > 0) return prop.examples[0];

  switch (prop.type) {
    case 'string':
      // 根据属性名猜测示例值
      if (prop.format === 'path' || prop.format === 'file-path') return '/path/to/file';
      if (prop.format === 'uri' || prop.format === 'url') return 'https://example.com';
      if (prop.format === 'email') return 'user@example.com';
      if (/path|file|dir/i.test(prop.description || '')) return '/path/to/file';
      if (/url|link|href/i.test(prop.description || '')) return 'https://example.com';
      if (/name/i.test(prop.description || '')) return 'example_name';
      if (/id/i.test(prop.description || '')) return 'id_123';
      return 'example';
    case 'number':
    case 'integer':
      return 42;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'example';
  }
}

/**
 * 按模型家族格式化 few-shot 示例
 */
function formatExamples(examples, family) {
  switch (family) {
    case 'hermes':
      return formatHermesExamples(examples);
    case 'qwen':
      return formatQwenExamples(examples);
    case 'chatml':
      return formatChatMLExamples(examples);
    default:
      return formatGenericExamples(examples);
  }
}

/**
 * 通用格式示例
 */
function formatGenericExamples(examples) {
  const lines = [
    '当需要使用工具时，请使用以下格式：',
    '',
  ];

  for (const ex of examples) {
    const argsStr = JSON.stringify(ex.args);
    lines.push(`调用 ${ex.name}：`);
    lines.push(`{"name": "${ex.name}", "arguments": ${argsStr}}`);
    lines.push('');
  }

  lines.push('请确保工具调用使用正确的 JSON 格式。');

  return lines.join('\n');
}

/**
 * Hermes 格式示例（使用特殊 token）
 */
function formatHermesExamples(examples) {
  const lines = [
    '当需要使用工具时，请使用以下格式：',
    '<tool_call',
  ];

  for (const ex of examples) {
    const argsStr = JSON.stringify(ex.args);
    lines.push(`{"name": "${ex.name}", "arguments": ${argsStr}}`);
    lines.push('</tool_call');
  }

  lines.push('');
  lines.push('工具返回结果后使用 <tool_response 格式。');

  return lines.join('\n');
}

/**
 * Qwen 格式示例
 */
function formatQwenExamples(examples) {
  const lines = [
    '你可以使用以下工具。当需要调用工具时，请使用如下格式：',
    '```json',
  ];

  for (const ex of examples) {
    const argsStr = JSON.stringify(ex.args);
    lines.push(`{"name": "${ex.name}", "arguments": ${argsStr}}`);
  }

  lines.push('```');

  return lines.join('\n');
}

/**
 * ChatML 格式示例
 */
function formatChatMLExamples(examples) {
  const lines = [
    '你可以使用以下工具。调用工具时请输出 JSON 格式：',
    '',
  ];

  for (const ex of examples) {
    const argsStr = JSON.stringify(ex.args);
    lines.push('Action: ' + ex.name);
    lines.push('Action Input: ' + argsStr);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 主入口：注入 few-shot 示例到请求中
 * @param {object} openaiRequest - OpenAI 格式的请求
 * @returns {object} 注入示例后的请求
 */
function injectFewShot(openaiRequest) {
  if (!config.fewShotEnabled) return openaiRequest;

  // 没有工具则不需要注入
  if (!openaiRequest.tools || openaiRequest.tools.length === 0) {
    return openaiRequest;
  }

  const model = openaiRequest.model || config.defaultModel;
  const family = detectModelFamily(model);

  log('模型:', model, '家族:', family);

  // 选择要生成示例的工具（取前 N 个）
  const selectedTools = openaiRequest.tools.slice(0, config.fewShotMaxExamples);

  // 生成示例
  const examples = selectedTools.map((tool) => generateToolExample(tool, family));

  if (examples.length === 0) return openaiRequest;

  // 格式化示例
  const examplesText = formatExamples(examples, family);

  // 注入到系统提示中
  const messages = [...openaiRequest.messages];
  const systemIndex = messages.findIndex((m) => m.role === 'system');

  if (systemIndex >= 0) {
    // 追加到现有系统提示
    messages[systemIndex] = {
      ...messages[systemIndex],
      content: messages[systemIndex].content + '\n\n' + examplesText,
    };
  } else {
    // 插入新的系统提示
    messages.unshift({
      role: 'system',
      content: examplesText,
    });
  }

  log('注入了', examples.length, '个示例');

  return {
    ...openaiRequest,
    messages,
  };
}

/**
 * 带诊断报告的 Few-Shot 注入
 */
function injectFewShotWithReport(openaiRequest, diag) {
  if (!config.fewShotEnabled || !openaiRequest.tools || openaiRequest.tools.length === 0) {
    if (!openaiRequest.tools || openaiRequest.tools.length === 0) {
      diag.phase('Few-Shot注入', '无工具定义，跳过');
    } else {
      diag.phase('Few-Shot注入', '已禁用，跳过');
    }
    return openaiRequest;
  }

  const model = openaiRequest.model || config.defaultModel;
  const family = detectModelFamily(model);
  const selectedTools = openaiRequest.tools.slice(0, config.fewShotMaxExamples);
  const examples = selectedTools.map((tool) => generateToolExample(tool, family));

  diag.phase('Few-Shot注入', `模型=${model}, 家族=${family}, 生成${examples.length}个示例`);

  if (examples.length > 0) {
    const toolNames = examples.map(e => e.name).join(', ');
    diag.fix('Few-Shot注入', '无示例', `${examples.length}个示例`, `为工具 [${toolNames}] 注入了调用格式示例，引导模型正确输出`);
    diag.stat('注入示例数', examples.length);
    diag.stat('目标格式', family);
  }

  return injectFewShot(openaiRequest);
}

module.exports = {
  injectFewShot,
  injectFewShotWithReport,
  detectModelFamily,
  generateToolExample,
  formatExamples,
};
