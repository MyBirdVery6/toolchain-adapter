/**
 * JSON 修复引擎 - 三层修复策略
 *
 * 第一层：标准 JSON.parse
 * 第二层：jsonrepair 库修复（处理常见格式问题）
 * 第三层：正则表达式提取（兜底方案）
 *
 * 处理的场景：
 * - 截断的 JSON 字符串
 * - 缺少逗号
 * - 单引号替代双引号
 * - 未转义的新行符
 * - 尾部逗号
 * - 缺少括号
 * - 控制字符混入
 */

const { jsonrepair } = require('jsonrepair');
const config = require('./config');

function log(...args) {
  if (config.debugLogging) {
    console.log('[JSON修复]', ...args);
  }
}

/**
 * 三层 JSON 修复
 * @param {string} input - 待修复的 JSON 字符串
 * @param {*} defaultValue - 修复失败时返回的默认值
 * @returns {*} 解析后的值
 */
function repairJSON(input, defaultValue = null) {
  if (!config.jsonRepairEnabled) {
    try {
      return JSON.parse(input);
    } catch {
      return defaultValue;
    }
  }

  if (typeof input !== 'string') {
    return input;
  }

  const trimmed = input.trim();

  // ── 第一层：标准解析 ──
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    log('标准解析失败，尝试修复:', e.message);
  }

  // ── 第二层：jsonrepair 库 ──
  try {
    const repaired = jsonrepair(trimmed);
    const parsed = JSON.parse(repaired);
    log('jsonrepair 修复成功');
    return parsed;
  } catch (e) {
    log('jsonrepair 修复失败:', e.message);
  }

  // ── 第三层：正则表达式提取 ──
  try {
    const extracted = regexExtract(trimmed);
    if (extracted !== null) {
      log('正则提取成功');
      return extracted;
    }
  } catch (e) {
    log('正则提取失败:', e.message);
  }

  log('所有修复尝试均失败，返回默认值');
  return defaultValue;
}

/**
 * 第三层修复：正则表达式提取
 * 尝试从混乱的文本中提取出有效的 JSON 结构
 */
function regexExtract(input) {
  // 策略1：提取最外层的 {...} 或 [...]
  const objectMatch = extractOuterBraces(input, '{', '}');
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch);
    } catch {
      // 继续尝试修复提取的内容
      const fixed = fixCommonIssues(objectMatch);
      try {
        return JSON.parse(fixed);
      } catch { /* 继续下一个策略 */ }
    }
  }

  const arrayMatch = extractOuterBraces(input, '[', ']');
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch);
    } catch {
      const fixed = fixCommonIssues(arrayMatch);
      try {
        return JSON.parse(fixed);
      } catch { /* 继续 */ }
    }
  }

  // 策略2：提取 key=value 模式
  const kvMatch = input.match(/(\w+)\s*[:=]\s*["']?([^"'}\]]+)["']?/g);
  if (kvMatch && kvMatch.length > 0) {
    const obj = {};
    for (const m of kvMatch) {
      const parts = m.match(/(\w+)\s*[:=]\s*["']?([^"'}\]]*)["']?/);
      if (parts) {
        obj[parts[1]] = parts[2].trim();
      }
    }
    if (Object.keys(obj).length > 0) {
      return obj;
    }
  }

  return null;
}

/**
 * 提取最外层匹配的括号内容
 */
function extractOuterBraces(input, openChar, closeChar) {
  let depth = 0;
  let start = -1;

  for (let i = 0; i < input.length; i++) {
    if (input[i] === openChar) {
      if (depth === 0) start = i;
      depth++;
    } else if (input[i] === closeChar) {
      depth--;
      if (depth === 0 && start !== -1) {
        return input.substring(start, i + 1);
      }
    }
  }

  // 如果找到了开始但没找到结束，尝试补全
  if (start !== -1) {
    let result = input.substring(start);
    // 补全缺少的闭合括号
    let openCount = 0;
    for (const ch of result) {
      if (ch === openChar) openCount++;
      if (ch === closeChar) openCount--;
    }
    while (openCount > 0) {
      result += closeChar;
      openCount--;
    }
    return result;
  }

  return null;
}

/**
 * 修复常见 JSON 格式问题
 *
 * 注意：只在 JSON 字符串值内部转义换行符，不在 JSON 结构换行处替换
 * 否则会把合法的 JSON 格式化换行破坏为 \n 字面量
 */
function fixCommonIssues(input) {
  let fixed = input;

  // 1. 单引号 → 双引号（只替换JSON结构中的单引号，不替换字符串值内的撇号）
  // 策略：替换 key: 'value' 模式中的引号，不替换 It's 等英文撇号
  // 先替换 key: 'value' 中作为值界定符的单引号
  fixed = fixed.replace(/:\s*'([^']*?)'/g, (match, inner) => {
    return `: "${inner}"`;
  });
  // 替换 {'key': ...} 中作为属性名界定符的单引号
  fixed = fixed.replace(/\{\s*'([^']*?)'\s*:/g, (match, inner) => {
    return `{ "${inner}":`;
  });
  fixed = fixed.replace(/,\s*'([^']*?)'\s*:/g, (match, inner) => {
    return `, "${inner}":`;
  });

  // 2. 移除尾部逗号（对象和数组中的）
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // 3. 修复 JSON 字符串值内部的未转义换行符
  //    只替换出现在引号内的换行符，避免破坏 JSON 结构格式化
  fixed = fixed.replace(/"([^"]*)"/g, (match, inner) => {
    // 在字符串值内部，转义换行符
    const escaped = inner
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    if (escaped !== inner) {
      return '"' + escaped + '"';
    }
    return match;
  });

  // 4. 移除控制字符（除常见的空白符外）
  fixed = fixed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // 5. 修复缺少逗号的情况（两个字符串之间）
  // "value1" "key2" → "value1", "key2"
  fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');

  // 6. 修复缺少冒号的情况
  fixed = fixed.replace(/"(\w+)"\s+"(\w+)"/g, '"$1": "$2"');

  return fixed;
}

/**
 * 专门修复 tool_call 的 arguments 字段
 * 这是 JSON 修复最常见的场景：模型生成的工具调用参数 JSON 不合法
 *
 * @param {string} argumentsStr - 工具调用参数字符串
 * @returns {object} 解析后的参数对象
 */
function repairToolCallArguments(argumentsStr) {
  if (!argumentsStr) return {};

  // 如果已经是对象，直接返回
  if (typeof argumentsStr === 'object') return argumentsStr;

  const repaired = repairJSON(argumentsStr, null);

  if (repaired !== null && typeof repaired === 'object') {
    return repaired;
  }

  // 终极兜底：尝试提取所有 "key": "value" 对
  const fallback = {};
  const pattern = /"(\w+)"\s*:\s*(?:"([^"]*)"|(\d+(?:\.\d+)?)|(true|false|null))/g;
  let match;
  while ((match = pattern.exec(argumentsStr)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2]
      : match[3] !== undefined ? parseFloat(match[3])
      : match[4] === 'true' ? true
      : match[4] === 'false' ? false
      : null;
    fallback[key] = value;
  }

  return Object.keys(fallback).length > 0 ? fallback : {};
}

/**
 * 批量修复响应中所有工具调用的 arguments
 * @param {object} openaiResponse - OpenAI 格式的响应
 * @returns {object} 修复后的响应
 */
function repairResponseToolCalls(openaiResponse) {
  if (!openaiResponse?.choices?.[0]?.message?.tool_calls) {
    return openaiResponse;
  }

  for (const tc of openaiResponse.choices[0].message.tool_calls) {
    if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
      try {
        // 先尝试标准解析
        JSON.parse(tc.function.arguments);
      } catch {
        // 解析失败，进行修复
        log('修复工具调用参数:', tc.function.name);
        const repairedArgs = repairToolCallArguments(tc.function.arguments);
        tc.function.arguments = JSON.stringify(repairedArgs);
      }
    }
  }

  return openaiResponse;
}

/**
 * 带诊断报告的响应工具调用参数修复
 */
function repairResponseToolCallsWithReport(openaiResponse, diag) {
  if (!openaiResponse?.choices?.[0]?.message?.tool_calls) {
    diag.phase('JSON修复', '响应中无工具调用，跳过');
    return openaiResponse;
  }

  const toolCalls = openaiResponse.choices[0].message.tool_calls;
  let repairCount = 0;
  const repairedTools = [];

  for (const tc of toolCalls) {
    if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
      try {
        JSON.parse(tc.function.arguments);
      } catch (originalErr) {
        // 记录原始错误
        const originalArgs = tc.function.arguments;
        const toolName = tc.function.name || 'unknown';

        // 执行修复
        const repairedArgs = repairToolCallArguments(tc.function.arguments);
        tc.function.arguments = JSON.stringify(repairedArgs);

        repairCount++;
        repairedTools.push(toolName);

        diag.issue('JSON修复引擎', `工具 ${toolName} 的 arguments 不是合法JSON: ${originalErr.message}`, 'error');
        diag.fix('JSON修复引擎', originalArgs.substring(0, 120), tc.function.arguments.substring(0, 120),
          `修复了工具 ${toolName} 的畸形JSON参数`);
      }
    }
  }

  if (repairCount === 0) {
    diag.phase('JSON修复', `${toolCalls.length}个工具调用参数均合法`);
  } else {
    diag.phase('JSON修复', `修复了${repairCount}个工具的畸形JSON: [${repairedTools.join(', ')}]`);
  }

  return openaiResponse;
}

module.exports = {
  repairJSON,
  repairToolCallArguments,
  repairResponseToolCalls,
  repairResponseToolCallsWithReport,
  fixCommonIssues,
};
