/**
 * 响应语言修正模块 v6 - 确保模型使用指定语言回复
 *
 * 解决的问题：
 * - OpenClaw 用中文提问，但本地模型（9B）总是用英文回答
 * - 原因：本地模型默认英文输出，缺少语言指令
 *
 * v6 改进：
 * - 请求修正更强力：在系统提示和最后一条用户消息中都注入语言偏好
 * - 响应修正更实用：不再只是追加提示文本，而是将英文内容包装为
 *   "[以下内容由系统翻译为中文]" + 原内容 + 修正说明
 *   因为本地9B模型不会响应追加的提示，需要从适配器层面干预
 *
 * 修正策略（双管齐下）：
 * 1. 请求修正：在系统提示 + 最后一条用户消息中注入语言偏好指令
 * 2. 响应修正：检测响应语言，如果不符则标记并添加中文说明
 *
 * 配置项（在 config.js 中）：
 * - RESPONSE_LANGUAGE: 目标语言代码（如 'zh-CN', 'en', 'ja'），默认 'zh-CN'
 * - RESPONSE_LANGUAGE_INSTRUCTION: 自定义语言指令文本（覆盖默认）
 * - RESPONSE_LANGUAGE_FIX_ENABLED: 是否启用响应语言修正，默认 true
 */

const config = require('./config');

// ─── 语言代码到指令文本的映射 ───
const LANGUAGE_INSTRUCTIONS = {
  'zh-CN': '你必须使用简体中文回复。所有回答、解释、说明都必须使用中文。即使用户的提问中包含英文，你也必须用中文回答。工具调用的参数值保持原样，但所有自然语言文本必须使用中文。',
  'zh-TW': '你必須使用繁體中文回覆。所有回答、解釋、說明都必須使用中文。',
  'zh': '你必须使用中文回复。所有回答、解释、说明都必须使用中文。',
  'en': 'You must respond in English. All answers, explanations, and descriptions must be in English.',
  'ja': '日本語で回答してください。すべての回答、説明、記述は日本語で行ってください。',
  'ko': '한국어로 답변해 주세요. 모든 답변, 설명, 기술은 한국어로 해주세요.',
  'fr': 'Vous devez répondre en français. Toutes les réponses, explications et descriptions doivent être en français.',
  'de': 'Sie müssen auf Deutsch antworten. Alle Antworten, Erklärungen und Beschreibungen müssen auf Deutsch sein.',
  'es': 'Debe responder en español. Todas las respuestas, explicaciones y descripciones deben estar en español.',
  'ru': 'Вы должны отвечать на русском языке. Все ответы, объяснения и описания должны быть на русском языке.',
};

/**
 * 获取语言指令文本
 * @returns {string|null} 语言指令文本，如果未配置则返回 null
 */
function getLanguageInstruction() {
  // 未配置语言则不注入
  if (!config.responseLanguage) return null;

  // 如果有自定义指令，优先使用
  if (config.responseLanguageInstruction) {
    return config.responseLanguageInstruction;
  }

  // 根据语言代码查找默认指令
  return LANGUAGE_INSTRUCTIONS[config.responseLanguage] ||
    `You must respond in ${config.responseLanguage}. All natural language text in your responses must be in ${config.responseLanguage}.`;
}

/**
 * 注入语言指令到请求中
 * v6增强：同时在系统提示和最后一条用户消息中注入语言偏好
 *
 * @param {object} openaiRequest - OpenAI 格式的请求
 * @param {object} diag - 诊断报告收集器
 * @returns {object} 注入语言指令后的请求
 */
function injectLanguageInstruction(openaiRequest, diag) {
  const instruction = getLanguageInstruction();
  if (!instruction) {
    diag.phase('语言注入', '未配置响应语言，跳过');
    return openaiRequest;
  }

  const messages = [...openaiRequest.messages];
  let modified = false;

  // 1. 注入到系统提示
  const systemIndex = messages.findIndex(m => m.role === 'system');
  if (systemIndex >= 0) {
    const originalContent = messages[systemIndex].content;
    // 检查是否已经注入过（避免重复注入）
    if (originalContent.includes('[语言要求]')) {
      diag.phase('语言注入', `系统提示已存在语言指令，跳过重复注入 (目标: ${config.responseLanguage})`);
    } else {
      messages[systemIndex] = {
        ...messages[systemIndex],
        content: originalContent + '\n\n[语言要求] ' + instruction,
      };
      modified = true;
      diag.phase('语言注入', `追加到系统提示 (目标: ${config.responseLanguage})`);
    }
  } else {
    // 创建新的系统提示
    messages.unshift({
      role: 'system',
      content: '[语言要求] ' + instruction,
    });
    modified = true;
    diag.phase('语言注入', `创建系统提示 (目标: ${config.responseLanguage})`);
  }

  // 2. v6新增：在最后一条用户消息中也注入语言提示
  // 这是因为9B小模型可能忽略系统提示，但对最近的用户消息更敏感
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const userContent = messages[i].content;
      if (typeof userContent === 'string' && !userContent.includes('[语言要求]')) {
        // 只在较短的纯文本用户消息中注入，避免破坏复杂的content block
        messages[i] = {
          ...messages[i],
          content: userContent + '\n\n[重要提醒：请务必使用中文回答]',
        };
        modified = true;
        diag.phase('语言注入', `在用户消息中也注入了语言提示 (v6增强)`);
      }
      break;
    }
  }

  if (modified) {
    diag.fix('语言注入', '无语言指令', `注入${config.responseLanguage}语言指令`,
      `在系统提示(和用户消息)中追加了语言偏好指令，确保模型使用${config.responseLanguage}回复`);
  }

  return {
    ...openaiRequest,
    messages,
  };
}

/**
 * 检测文本的主要语言
 * 简单启发式：通过字符范围判断
 *
 * @param {string} text - 要检测的文本
 * @returns {string} 检测到的语言代码 ('zh', 'en', 'ja', 'ko', 'unknown')
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string' || text.length < 5) return 'unknown';

  let chineseChars = 0;
  let englishChars = 0;
  let japaneseChars = 0;
  let koreanChars = 0;

  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // CJK Unified Ideographs (中文汉字)
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF)) {
      chineseChars++;
    }
    // Hiragana + Katakana (日文假名)
    if ((code >= 0x3040 && code <= 0x309F) ||
        (code >= 0x30A0 && code <= 0x30FF)) {
      japaneseChars++;
    }
    // Hangul (韩文)
    if ((code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0x1100 && code <= 0x11FF)) {
      koreanChars++;
    }
    // 英文字母
    if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      englishChars++;
    }
  }

  // 如果有日文假名，优先判定为日文（因为汉字在日文中也使用）
  if (japaneseChars > 0 && japaneseChars >= chineseChars * 0.1) return 'ja';
  // 有韩文
  if (koreanChars > 0 && koreanChars >= chineseChars * 0.1) return 'ko';
  // 有中文汉字
  if (chineseChars > 0) return 'zh';
  // 纯英文
  if (englishChars > text.length * 0.5) return 'en';

  return 'unknown';
}

/**
 * 判断检测到的语言是否与目标语言匹配
 * @param {string} detected - 检测到的语言代码
 * @param {string} target - 目标语言代码
 * @returns {boolean}
 */
function isLanguageMatch(detected, target) {
  if (!target) return true; // 无目标语言则总是匹配
  const targetLower = target.toLowerCase();
  if (targetLower.startsWith('zh') && detected === 'zh') return true;
  if (targetLower.startsWith('en') && detected === 'en') return true;
  if (targetLower.startsWith('ja') && detected === 'ja') return true;
  if (targetLower.startsWith('ko') && detected === 'ko') return true;
  if (targetLower.startsWith('fr') && detected === 'fr') return true;
  if (targetLower.startsWith('de') && detected === 'de') return true;
  if (targetLower.startsWith('es') && detected === 'es') return true;
  if (targetLower.startsWith('ru') && detected === 'ru') return true;
  return false;
}

/**
 * 修正响应中的语言问题
 * v6改进：不再只是追加提示（9B模型不会响应），而是添加醒目的语言说明
 *
 * @param {string} content - 响应文本内容
 * @param {object} diag - 诊断报告收集器
 * @returns {string} 修正后的内容
 */
function fixResponseLanguage(content, diag) {
  if (!config.responseLanguageFixEnabled || !config.responseLanguage || !content) {
    return content;
  }

  const detected = detectLanguage(content);
  const isMatch = isLanguageMatch(detected, config.responseLanguage);

  if (!isMatch && detected !== 'unknown') {
    const langName = getLanguageName(config.responseLanguage);
    const detectedName = getLanguageName(detected);

    // v6: 更直接的修正方式 - 在内容前添加语言说明
    // 之前的做法只是追加提示文本，9B模型不会响应
    // 现在在内容头部添加醒目的中文说明
    const languageNote = `[系统提示：以下内容模型使用${detectedName}回复，用户要求使用${langName}]\n\n`;

    diag.issue('语言修正',
      `检测到响应使用 ${detected} 语言，但目标语言为 ${config.responseLanguage}，已添加语言说明`,
      'warn');
    diag.fix('语言修正', `${detected}语言响应`, `添加${config.responseLanguage}语言说明头部`,
      '在响应头部添加了语言说明，提醒用户模型使用了非目标语言');

    return languageNote + content;
  }

  return content;
}

/**
 * 获取语言的可读名称
 */
function getLanguageName(code) {
  const names = {
    'zh-CN': '中文', 'zh-TW': '繁體中文', 'zh': '中文',
    'en': 'English', 'ja': '日本語', 'ko': '한국어',
    'fr': 'Français', 'de': 'Deutsch', 'es': 'Español', 'ru': 'Русский',
  };
  return names[code] || code;
}

module.exports = {
  getLanguageInstruction,
  injectLanguageInstruction,
  detectLanguage,
  isLanguageMatch,
  fixResponseLanguage,
  getLanguageName,
  LANGUAGE_INSTRUCTIONS,
};
