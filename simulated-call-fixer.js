/**
 * 模拟调用修复器 - 检测并修复模型输出的"模拟"工具调用
 *
 * 问题：本地模型有时不输出结构化的工具调用格式，而是用文本描述：
 * - "I'll call get_weather(location='SF')"
 * - "Calling: read_file('/path/to/file')"
 * - "Let me use the search tool with query 'hello'"
 * - 直接输出裸的控制 token，如 <|tool_calls_section|>
 *
 * 本模块检测这些模式并将其转换为正确的 tool_calls 格式
 */

const { v4: uuidv4 } = require('uuid');
const { repairToolCallArguments } = require('./json-repair');
const config = require('./config');

function log(...args) {
  if (config.debugLogging) {
    console.log('[模拟调用修复]', ...args);
  }
}

/**
 * 模拟调用的文本模式
 * 每个模式包含正则表达式和提取工具名/参数的方法
 */
const SIMULATED_CALL_PATTERNS = [
  // 模式1: "I'll call tool_name(key='value', key2='value2')"
  {
    name: 'parenthesized_kwargs',
    regex: /(?:call|use|invoke|execute|run)\s+(\w+)\s*\(([^)]*)\)/gi,
    extract: (match) => {
      const toolName = match[1];
      const argsStr = match[2];
      return {
        toolName,
        args: parseKwargs(argsStr),
      };
    },
  },

  // 模式2: "Calling: tool_name" 后面跟着参数
  {
    name: 'colon_style',
    regex: /(?:calling|using|running):\s*(\w+)(?:\s+(?:with|for|on)\s+(.+?))?$/gim,
    extract: (match) => {
      const toolName = match[1];
      const argsStr = match[2] || '';
      return {
        toolName,
        args: parseNaturalLanguageArgs(argsStr),
      };
    },
  },

  // 模式3: "Let me use the tool_name tool with ..."
  {
    name: 'let_me_use',
    regex: /let\s+me\s+(?:use|call)\s+(?:the\s+)?(\w+)(?:\s+tool)?(?:\s+(?:with|for|on|to)\s+(.+?))?$/gim,
    extract: (match) => {
      const toolName = match[1];
      const argsStr = match[2] || '';
      return {
        toolName,
        args: parseNaturalLanguageArgs(argsStr),
      };
    },
  },

  // 模式4: 直接输出 JSON 格式的工具调用（但不在 tool_calls 结构中）
  // {"name": "tool_name", "arguments": {...}}
  {
    name: 'inline_json',
    regex: /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g,
    extract: (match) => {
      const toolName = match[1];
      try {
        const args = JSON.parse(match[2]);
        return { toolName, args };
      } catch {
        return { toolName, args: repairToolCallArguments(match[2]) };
      }
    },
  },

  // 模式5: Action: tool_name\nAction Input: {...}
  {
    name: 'action_style',
    regex: /Action:\s*(\w+)\s*\n\s*Action\s*Input:\s*(\{[^}]*\})/gi,
    extract: (match) => {
      const toolName = match[1];
      try {
        const args = JSON.parse(match[2]);
        return { toolName, args };
      } catch {
        return { toolName, args: repairToolCallArguments(match[2]) };
      }
    },
  },

  // 模式6: ```json\n{"name": "...", "arguments": ...}\n```
  {
    name: 'code_block_json',
    regex: /```(?:json)?\s*\n?\s*\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*\n?\s*```/gi,
    extract: (match) => {
      const toolName = match[1];
      try {
        const args = JSON.parse(match[2]);
        return { toolName, args };
      } catch {
        return { toolName, args: repairToolCallArguments(match[2]) };
      }
    },
  },
];

/**
 * 控制字符泄漏模式
 * 本地模型有时直接输出训练数据中的控制 token
 */
const CONTROL_TOKEN_PATTERNS = [
  // Hermes 格式控制 token
  /<\|tool_calls_section\|>/g,
  /<\|tool_call\|>/g,
  /<\/\|tool_call\|>/g,
  /<\|tool_response\|>/g,
  /<\/\|tool_response\|>/g,

  // ChatML 控制token
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,

  // 其他常见控制 token
  /<\|function_call\|>/g,
  /<\/\|function_call\|>/g,
  /<\|system\|>/g,
  /<\|assistant\|>/g,
  /<\|user\|>/g,
  /<\|endoftext\|>/g,
  /<\|end\|>/g,
];

/**
 * 解析关键字参数格式：key='value', key2='value2'
 */
function parseKwargs(argsStr) {
  if (!argsStr || !argsStr.trim()) return {};

  const args = {};
  // 匹配 key='value' 或 key="value" 或 key=value
  const kwargPattern = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match;

  while ((match = kwargPattern.exec(argsStr)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2]
      : match[3] !== undefined ? match[3]
      : match[4] !== undefined ? match[4]
      : '';

    // 尝试转换类型
    args[key] = tryParseValue(value);
  }

  return args;
}

/**
 * 解析自然语言参数
 */
function parseNaturalLanguageArgs(argsStr) {
  if (!argsStr || !argsStr.trim()) return {};

  const args = {};

  // 尝试匹配 key='value' 格式
  const kwargs = parseKwargs(argsStr);
  if (Object.keys(kwargs).length > 0) return kwargs;

  // 尝试匹配引号内的值
  const quotedMatch = argsStr.match(/['"]([^'"]+)['"]/g);
  if (quotedMatch && quotedMatch.length > 0) {
    const values = quotedMatch.map((v) => v.replace(/['"]/g, ''));
    // 如果只有一个值，使用通用的参数名
    if (values.length === 1) {
      args.query = values[0];
      args.input = values[0];
    } else {
      values.forEach((v, i) => {
        args[`arg${i + 1}`] = v;
      });
    }
    return args;
  }

  // 兜底：整个字符串作为 query 参数
  const cleaned = argsStr.replace(/^(with|for|on|to)\s+/i, '').trim();
  if (cleaned) {
    args.query = cleaned;
    args.input = cleaned;
  }

  return args;
}

/**
 * 尝试将字符串值解析为合适的类型
 */
function tryParseValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;

  // 数字
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  return value;
}

/**
 * 清除文本中的控制 token
 */
function cleanControlTokens(text) {
  if (!text) return text;

  let cleaned = text;
  for (const pattern of CONTROL_TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned.trim();
}

/**
 * 检测文本中的模拟工具调用
 * @param {string} text - 模型输出的文本
 * @returns {Array} 检测到的工具调用列表
 */
function detectSimulatedCalls(text) {
  if (!text || typeof text !== 'string') return [];

  const detectedCalls = [];

  for (const pattern of SIMULATED_CALL_PATTERNS) {
    pattern.regex.lastIndex = 0; // 重置正则状态
    let match;

    while ((match = pattern.regex.exec(text)) !== null) {
      try {
        const result = pattern.extract(match);
        if (result && result.toolName) {
          log(`检测到模拟调用 [${pattern.name}]: ${result.toolName}`);
          detectedCalls.push(result);
        }
      } catch (err) {
        log(`模式 ${pattern.name} 提取失败:`, err.message);
      }
    }
  }

  return detectedCalls;
}

/**
 * 将检测到的模拟调用转换为 OpenAI tool_calls 格式
 */
function convertToToolCalls(detectedCalls) {
  return detectedCalls.map((call) => ({
    id: `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: {
      name: call.toolName,
      arguments: JSON.stringify(call.args),
    },
  }));
}

/**
 * 主入口：修复 OpenAI 响应中的模拟调用
 *
 * @param {object} openaiResponse - OpenAI 格式的响应
 * @param {Array} availableTools - 可用工具列表（用于验证工具名）
 * @returns {object} 修复后的响应
 */
function fixSimulatedCalls(openaiResponse, availableTools) {
  if (!config.simulatedCallFixerEnabled) return openaiResponse;

  const message = openaiResponse?.choices?.[0]?.message;
  if (!message) return openaiResponse;

  // 如果已经有结构化的 tool_calls，只需要清理控制 token
  if (message.tool_calls && message.tool_calls.length > 0) {
    // 清理 content 中的控制 token
    if (typeof message.content === 'string') {
      message.content = cleanControlTokens(message.content);
    }
    // 清理 tool_calls arguments 中的控制 token
    for (const tc of message.tool_calls) {
      if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
        tc.function.arguments = cleanControlTokens(tc.function.arguments);
      }
    }
    return openaiResponse;
  }

  // 没有 tool_calls，检查 content 中的模拟调用
  if (!message.content || typeof message.content !== 'string') {
    return openaiResponse;
  }

  // 先清理控制 token
  message.content = cleanControlTokens(message.content);

  // 检测模拟调用
  const detectedCalls = detectSimulatedCalls(message.content);
  if (detectedCalls.length === 0) {
    return openaiResponse;
  }

  // 验证检测到的工具名是否在可用工具中
  const validToolNames = new Set();
  if (availableTools && Array.isArray(availableTools)) {
    for (const tool of availableTools) {
      const name = tool.function?.name || tool.name;
      if (name) validToolNames.add(name);
    }
  }

  const validCalls = detectedCalls.filter(
    (call) => validToolNames.size === 0 || validToolNames.has(call.toolName)
  );

  if (validCalls.length === 0) {
    log('检测到模拟调用但工具名不在可用列表中，跳过修复');
    return openaiResponse;
  }

  // 转换为 tool_calls 格式
  const toolCalls = convertToToolCalls(validCalls);
  log(`修复了 ${toolCalls.length} 个模拟调用`);

  // 从 content 中移除模拟调用的文本
  // v6修复: 之前的过滤太激进，会删除包含常见英文单词(use/call/invoke)的行
  // 现在改为只移除包含模拟调用关键文本的行，保留其他内容
  let cleanContent = message.content;
  for (const call of detectedCalls) {
    // 只移除包含工具调用模式的行，不再删除包含常见英文单词的行
    const lines = cleanContent.split('\n');
    cleanContent = lines
      .filter((line) => {
        const lineLower = line.toLowerCase();
        // 移除包含具体工具调用指令的行（如 "Action: toolName" 或 "call toolName("）
        if (lineLower.includes(call.toolName.toLowerCase()) &&
            (/\b(?:action|call|use|invoke|execute)\s*:/i.test(lineLower) ||
             /\b(?:action|call|use|invoke|execute)\s+\w+/i.test(lineLower))) {
          return false;
        }
        // 移除工具调用的JSON块
        if (lineLower.includes('"name"') && lineLower.includes(call.toolName.toLowerCase())) {
          return false;
        }
        return true;
      })
      .join('\n')
      .trim();
  }

  // 更新响应
  openaiResponse.choices[0].message.tool_calls = toolCalls;
  openaiResponse.choices[0].message.content = cleanContent || null;
  openaiResponse.choices[0].finish_reason = 'tool_calls';

  return openaiResponse;
}

/**
 * 带诊断报告的模拟调用修复
 */
function fixSimulatedCallsWithReport(openaiResponse, availableTools, diag) {
  if (!config.simulatedCallFixerEnabled) {
    diag.phase('模拟调用修复', '已禁用，跳过');
    return openaiResponse;
  }

  const message = openaiResponse?.choices?.[0]?.message;
  if (!message) {
    diag.phase('模拟调用修复', '响应无消息内容，跳过');
    return openaiResponse;
  }

  // 如果已经有结构化的 tool_calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    // 检查控制token
    let controlTokensFound = [];
    if (typeof message.content === 'string') {
      for (const pattern of CONTROL_TOKEN_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(message.content)) {
          controlTokensFound.push(pattern.source.substring(0, 30));
        }
      }
    }

    if (controlTokensFound.length > 0) {
      diag.issue('模拟调用修复器', `已有tool_calls但content中存在${controlTokensFound.length}处控制token泄漏`, 'warn');
      diag.fix('模拟调用修复器', '含控制token', '已清理', `清理了响应中的泄漏控制token`);
    }

    diag.phase('模拟调用修复', `已有${message.tool_calls.length}个结构化tool_calls${controlTokensFound.length > 0 ? '，清理了控制token' : ''}`);
    // 仍然执行清理
    return fixSimulatedCalls(openaiResponse, availableTools);
  }

  // 没有tool_calls，检查content中的模拟调用
  if (!message.content || typeof message.content !== 'string') {
    diag.phase('模拟调用修复', '无文本内容可检查');
    return openaiResponse;
  }

  const detectedCalls = detectSimulatedCalls(message.content);

  if (detectedCalls.length > 0) {
    const toolNames = detectedCalls.map(c => c.toolName).join(', ');
    diag.issue('模拟调用修复器', `模型用文本而非结构化格式描述了工具调用: [${toolNames}]`, 'error');
    diag.fix('模拟调用修复器', '文本描述的工具调用', '结构化tool_calls', `将 ${detectedCalls.length} 个文本描述的工具调用 [${toolNames}] 转换为正确的 tool_calls 格式`);
  } else {
    // 检查是否有控制token
    let hasControlTokens = false;
    for (const pattern of CONTROL_TOKEN_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(message.content)) {
        hasControlTokens = true;
        break;
      }
    }
    if (hasControlTokens) {
      diag.issue('模拟调用修复器', '响应文本中存在泄漏的控制token', 'warn');
      diag.fix('模拟调用修复器', '含控制token', '已清理', '清理了响应中泄漏的特殊标记');
    } else {
      diag.phase('模拟调用修复', '未检测到模拟调用或控制token');
    }
  }

  return fixSimulatedCalls(openaiResponse, availableTools);
}

module.exports = {
  fixSimulatedCalls,
  fixSimulatedCallsWithReport,
  detectSimulatedCalls,
  cleanControlTokens,
  convertToToolCalls,
};
