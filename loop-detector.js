/**
 * 循环检测器 v6 - 修复交替式死循环 + 新增响应内容重复检测
 *
 * v6 关键修复：
 * - 修复交替式死循环检测失败：OpenClaw 的死循环模式是 A,B,A,B...
 *   之前的 countRecentRepeats 只检查"从末尾开始连续相同的哈希"
 *   交替模式下永远不会触发，现增加窗口内哈希频率检测
 * - 新增响应内容重复检测：当模型反复生成相同的纯文本响应，说明卡住
 * - 新增 ResponseHashTracker 类，跟踪响应内容哈希
 * - 统一请求和响应两端的检测逻辑
 *
 * 检测层级（按优先级）：
 * 0. 请求内容哈希连续重复检测（最直接，连续N次相同）
 * 0.5. 请求内容哈希窗口频率检测（v6新增，解决交替式死循环）
 * 1. 请求消息历史扫描（扫描messages中tool_calls的累计出现次数）
 * 2. 精确匹配（相同工具名 + 相同参数）
 * 3. 工具名频率（同一工具在窗口内调用N次，不管参数）
 * 4. 语义相似度（同一工具 + 核心意图相似）
 * R0. 响应内容哈希连续重复检测（v6新增）
 */

const crypto = require('crypto');
const config = require('./config');
const { v4: uuidv4 } = require('uuid');

// ─── 强制输出日志，不受 DEBUG_LOGGING 控制 ───
function log(...args) {
  console.log('[循环检测]', ...args);
}

function warn(...args) {
  console.warn('[循环检测-警告]', ...args);
}

function error(...args) {
  console.error('[循环检测-错误]', ...args);
}

// ═══════════════════════════════════════════════════════
//  命令内容归一化（继承 v5，修复潜在bug）
// ═══════════════════════════════════════════════════════

/**
 * 归一化命令/参数内容中的易变模式
 *
 * 归一化规则：
 * - 替换时间戳模式为 <TIMESTAMP>
 * - 替换日期模式为 <DATE>
 * - 替换MD5/SHA哈希值为 <HASH>
 * - 替换Base64编码串为 <BASE64>
 * - 替换数字ID为 <NUM_ID>
 * - 保留URL、查询参数、命令结构等核心内容
 */
function normalizeCommandContent(str) {
  if (!str || typeof str !== 'string') return str || '';

  let normalized = str;

  // 1. 替换 ISO 8601 时间戳 (2024-01-15T10:30:00.000Z)
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TIMESTAMP>');

  // 2. 替换常见时间戳格式
  // PowerShell: Get-Date -Format 'yyyyMMddHHmmss' 产生的 20240115103000
  normalized = normalized.replace(/\b\d{14}\b/g, '<TIMESTAMP>');
  // Unix 时间戳 (秒级 10位, 毫秒级 13位)
  // v6修复: 先替换13位再替换10位，避免10位匹配13位的前10位
  normalized = normalized.replace(/\b\d{13}\b/g, '<TIMESTAMP>');
  normalized = normalized.replace(/\b\d{10}\b/g, '<TIMESTAMP>');

  // 3. 替换日期格式
  normalized = normalized.replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '<DATE>');
  normalized = normalized.replace(/\b\d{2}[-/]\d{2}[-/]\d{4}\b/g, '<DATE>');

  // 4. 替换 MD5 哈希值 (32位十六进制) - 必须在短哈希之前
  normalized = normalized.replace(/\b[0-9a-fA-F]{32}\b/g, '<HASH>');
  // 替换 SHA256 哈希值 (64位十六进制)
  normalized = normalized.replace(/\b[0-9a-fA-F]{64}\b/g, '<HASH>');
  // 替换引号内的短哈希/签名值 (8-40位十六进制, 常见的API签名、appid等)
  normalized = normalized.replace(/["'][0-9a-fA-F]{8,40}["']/g, '"<SIGNATURE>"');

  // 5. 替换 Base64 编码串 (至少16字符的Base64)
  normalized = normalized.replace(/['"][A-Za-z0-9+/=]{16,}['"]/g, '"<BASE64>"');

  // 6. 替换 URL 中的签名参数 (&sig=xxx, &sign=xxx, &timestamp=xxx)
  normalized = normalized.replace(/[&?]sig(?:nature)?=[^&'"\s]+/gi, '&sig=<SIGNATURE>');
  normalized = normalized.replace(/[&?]timestamp=\d+/gi, '&timestamp=<TIMESTAMP>');
  normalized = normalized.replace(/[&?]t=\d+/gi, '&t=<TIMESTAMP>');

  // 7. 替换 PowerShell 变量中的时间戳生成 ($ts = Get-Date...)
  normalized = normalized.replace(/\$ts\s*=\s*Get-Date[^;'\n]*/gi, '$ts=<TIMESTAMP>');

  // 8. 替换 X-Auth-* 头部值 (兼容多种格式: JSON、PowerShell哈希表等)
  normalized = normalized.replace(/X-Auth-TimeStamp['"]?\s*[:=]\s*['"]?\d+['"]?/gi, 'X-Auth-TimeStamp=<TIMESTAMP>');
  normalized = normalized.replace(/X-Auth-Sign['"]?\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]+['"]?/gi, 'X-Auth-Sign=<SIGNATURE>');
  normalized = normalized.replace(/X-Auth-Appid['"]?\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]+['"]?/gi, 'X-Auth-Appid=<APPID>');

  // 9. 替换 Authorization 头部值
  normalized = normalized.replace(/Authorization['"]?\s*:\s*['"]?[Bb]earer\s+\S+['"]?/gi, 'Authorization:<BEARER_TOKEN>');

  return normalized;
}

/**
 * 归一化参数对象中的易变字段值
 * 不再删除 command/cmd 字段，而是对其值做归一化
 */
function normalizeArgsObject(argsObj) {
  if (!argsObj || typeof argsObj !== 'object') return argsObj;

  // v6修复: 数组必须特殊处理，否则 Object.entries 会将数组转为对象
  if (Array.isArray(argsObj)) {
    return argsObj.map(v => {
      if (typeof v === 'string') return normalizeCommandContent(v);
      if (typeof v === 'object' && v !== null) return normalizeArgsObject(v);
      return v;
    });
  }

  const normalized = {};
  for (const [key, value] of Object.entries(argsObj)) {
    if (typeof value === 'string') {
      normalized[key] = normalizeCommandContent(value);
    } else if (typeof value === 'number') {
      // 大数字可能是时间戳
      if (value > 1000000000000) {
        normalized[key] = '<TIMESTAMP>';
      } else if (value > 1000000000) {
        normalized[key] = '<TIMESTAMP>';
      } else {
        normalized[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      // 递归处理嵌套对象（如 headers）
      normalized[key] = normalizeArgsObject(value);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

// ═══════════════════════════════════════════════════════
//  请求内容哈希追踪器（全局，不依赖sessionId）
// ═══════════════════════════════════════════════════════

class RequestHashTracker {
  constructor() {
    // 最近的请求哈希序列 [{ hash, toolName, timestamp }]
    this.recentHashes = [];
    // 最大保留数量
    this.maxSize = 1000;
  }

  /**
   * 计算请求中工具调用内容的哈希
   * 保留所有字段，对字符串值做归一化（去除易变模式）
   */
  computeHash(toolName, args) {
    let coreArgs = args;
    if (typeof args === 'string') {
      try {
        coreArgs = JSON.parse(args);
      } catch {
        // 解析失败，先归一化原始字符串再计算哈希
        const normalizedStr = normalizeCommandContent(args);
        return crypto.createHash('md5')
          .update(`${toolName}:${normalizedStr}`)
          .digest('hex')
          .substring(0, 16);
      }
    }

    if (typeof coreArgs === 'object' && coreArgs !== null) {
      const normalized = normalizeArgsObject(coreArgs);

      // 对 key 排序后序列化，确保哈希稳定
      const sorted = Object.keys(normalized).sort()
        .map(k => `${k}=${JSON.stringify(normalized[k])}`).join('&');
      return crypto.createHash('md5')
        .update(`${toolName}:${sorted}`)
        .digest('hex')
        .substring(0, 16);
    }

    // 其他类型直接转字符串
    const normalizedStr = normalizeCommandContent(String(args));
    return crypto.createHash('md5')
      .update(`${toolName}:${normalizedStr}`)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * 记录一个请求哈希
   */
  record(toolName, args, hash) {
    if (!hash) {
      hash = this.computeHash(toolName, args);
    }
    this.recentHashes.push({ hash, toolName, timestamp: Date.now() });
    while (this.recentHashes.length > this.maxSize) {
      this.recentHashes.shift();
    }
    return hash;
  }

  /**
   * 检查同一内容哈希在最近N个请求中连续重复了多少次
   * 从最新往前数，遇到不同哈希就停止
   *
   * @param {string} hash - 要检查的哈希值
   * @returns {number} 连续重复次数（包含当前这次）
   */
  countRecentRepeats(hash) {
    let count = 0;
    for (let i = this.recentHashes.length - 1; i >= 0; i--) {
      if (this.recentHashes[i].hash === hash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * v6新增: 检查同一哈希在时间窗口内的总出现次数
   * 解决交替式死循环：A,B,A,B... 虽然不连续，但 A 在窗口内出现了很多次
   *
   * @param {string} hash - 要检查的哈希值
   * @param {number} lookbackSeconds - 回看时间窗口（秒）
   * @returns {number} 出现次数
   */
  countInTimeWindow(hash, lookbackSeconds) {
    const lookback = lookbackSeconds || config.loopDetectionWindowLookbackSeconds || 300;
    const now = Date.now();
    const cutoff = now - lookback * 1000;
    let count = 0;
    for (let i = this.recentHashes.length - 1; i >= 0; i--) {
      const entry = this.recentHashes[i];
      if (entry.timestamp < cutoff) break;
      if (entry.hash === hash) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取最近统计信息
   */
  getStats() {
    return {
      totalTracked: this.recentHashes.length,
      recentHashes: this.recentHashes.slice(-10).map(h => ({
        hash: h.hash,
        tool: h.toolName,
        time: new Date(h.timestamp).toISOString(),
      })),
    };
  }
}

// 全局哈希追踪器
const hashTracker = new RequestHashTracker();

// ═══════════════════════════════════════════════════════
//  响应内容哈希追踪器（v6新增）
// ═══════════════════════════════════════════════════════

/**
 * v6新增: 响应内容哈希追踪器
 *
 * 跟踪模型生成的响应内容（纯文本，不是工具调用）的哈希。
 * 当模型反复生成相同的文本响应时，说明模型卡住了。
 *
 * 典型场景：
 * - 模型不断输出 "I'll help you with that..." 然后调用同一工具
 * - 模型不断输出相同的错误信息
 * - 模型陷入 "I apologize, let me try again" 的循环
 */
class ResponseHashTracker {
  constructor() {
    // 最近的响应哈希序列 [{ hash, contentPreview, isToolCall, timestamp }]
    this.recentHashes = [];
    // 最大保留数量
    this.maxSize = 500;
  }

  /**
   * 计算响应内容的哈希
   * 对纯文本内容：去除空白字符后计算哈希（避免格式差异导致哈希不同）
   * 对工具调用：不计算哈希（工具调用的重复由请求端检测）
   *
   * @param {string} content - 响应文本内容
   * @param {boolean} isToolCall - 是否是工具调用响应
   * @returns {string|null} 哈希值，工具调用返回 null
   */
  computeHash(content, isToolCall) {
    // 工具调用不参与响应内容重复检测
    if (isToolCall) return null;

    if (!content || typeof content !== 'string' || content.length < 10) return null;

    // 归一化：去除多余空白、统一大小写（响应内容的大小写不影响语义）
    const normalized = content
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500); // 只取前500字符，避免长响应导致哈希不稳定

    return crypto.createHash('md5')
      .update(normalized)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * 记录一个响应哈希
   */
  record(content, isToolCall) {
    const hash = this.computeHash(content, isToolCall);
    if (!hash) return null;

    this.recentHashes.push({
      hash,
      contentPreview: content.substring(0, 80),
      isToolCall,
      timestamp: Date.now(),
    });

    while (this.recentHashes.length > this.maxSize) {
      this.recentHashes.shift();
    }

    return hash;
  }

  /**
   * 检查同一响应哈希连续重复了多少次
   * 从最新往前数，遇到不同哈希就停止
   *
   * @param {string} hash - 要检查的哈希值
   * @returns {number} 连续重复次数
   */
  countRecentRepeats(hash) {
    let count = 0;
    for (let i = this.recentHashes.length - 1; i >= 0; i--) {
      if (this.recentHashes[i].hash === hash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * 检查同一哈希在时间窗口内的总出现次数
   */
  countInTimeWindow(hash, lookbackSeconds) {
    const lookback = lookbackSeconds || config.loopDetectionWindowLookbackSeconds || 300;
    const now = Date.now();
    const cutoff = now - lookback * 1000;
    let count = 0;
    for (let i = this.recentHashes.length - 1; i >= 0; i--) {
      const entry = this.recentHashes[i];
      if (entry.timestamp < cutoff) break;
      if (entry.hash === hash) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取最近统计信息
   */
  getStats() {
    return {
      totalTracked: this.recentHashes.length,
      recentHashes: this.recentHashes.slice(-5).map(h => ({
        hash: h.hash,
        preview: h.contentPreview.substring(0, 40),
        time: new Date(h.timestamp).toISOString(),
      })),
    };
  }
}

// 全局响应哈希追踪器
const responseHashTracker = new ResponseHashTracker();

// ═══════════════════════════════════════════════════════
//  循环检测器类（保留原有的会话级检测）
// ═══════════════════════════════════════════════════════

class LoopDetector {
  constructor() {
    // 每个会话的调用历史（精确匹配用）
    this.sessionHistories = new Map();
    // 每个会话的工具名频率（工具名匹配用）
    this.sessionToolFrequencies = new Map();
    // 会话最后活跃时间
    this.sessionLastActive = new Map();
    // 全局最近调用序列（跨会话，用于检测全局死循环）
    this.globalCallSequence = [];
    // 循环打断计数（每个会话已打断的次数）
    this.breakCounts = new Map();
  }

  /**
   * 获取或创建会话的调用历史
   */
  getSessionHistory(sessionId) {
    if (!this.sessionHistories.has(sessionId)) {
      this.sessionHistories.set(sessionId, []);
    }
    if (!this.sessionToolFrequencies.has(sessionId)) {
      this.sessionToolFrequencies.set(sessionId, []);
    }
    this.sessionLastActive.set(sessionId, Date.now());
    return this.sessionHistories.get(sessionId);
  }

  /**
   * 获取会话的工具名频率历史
   */
  getSessionToolFreq(sessionId) {
    if (!this.sessionToolFrequencies.has(sessionId)) {
      this.sessionToolFrequencies.set(sessionId, []);
    }
    this.sessionLastActive.set(sessionId, Date.now());
    return this.sessionToolFrequencies.get(sessionId);
  }

  /**
   * 清理超过 30 分钟未活跃的会话
   */
  cleanupStaleSessions(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [sessionId, lastActive] of this.sessionLastActive) {
      if (now - lastActive > maxAgeMs) {
        this.sessionHistories.delete(sessionId);
        this.sessionToolFrequencies.delete(sessionId);
        this.sessionLastActive.delete(sessionId);
        this.breakCounts.delete(sessionId);
      }
    }
    // 清理全局序列（保留最近200条）
    if (this.globalCallSequence.length > 200) {
      this.globalCallSequence = this.globalCallSequence.slice(-200);
    }
  }

  /**
   * 记录一次工具调用
   */
  recordCall(sessionId, toolName, args) {
    if (!config.loopDetectionEnabled) return;

    const history = this.getSessionHistory(sessionId);
    const callRecord = {
      toolName,
      args: typeof args === 'string' ? args : JSON.stringify(args || {}),
      timestamp: Date.now(),
    };
    history.push(callRecord);
    while (history.length > config.loopDetectionWindowSize * 2) {
      history.shift();
    }

    const freqHistory = this.getSessionToolFreq(sessionId);
    freqHistory.push({ toolName, timestamp: Date.now() });
    while (freqHistory.length > config.loopDetectionWindowSize * 3) {
      freqHistory.shift();
    }

    this.globalCallSequence.push({
      sessionId,
      toolName,
      timestamp: Date.now(),
    });
    while (this.globalCallSequence.length > 200) {
      this.globalCallSequence.shift();
    }
  }

  /**
   * 提取工具参数中的核心查询意图（用于语义相似度匹配）
   */
  extractCoreIntent(args) {
    if (!args) return '';

    let argsObj = args;
    if (typeof args === 'string') {
      try { argsObj = JSON.parse(args); } catch { return args.substring(0, 100); }
    }

    if (typeof argsObj !== 'object' || argsObj === null) return String(args).substring(0, 100);

    const coreValues = [];
    const skipKeys = ['sig', 'signature', 'sign', 'timestamp', 'ts', 'appid', 'app_id',
      'header', 'headers', 'auth', 'authorization'];

    for (const [key, value] of Object.entries(argsObj)) {
      const keyLower = key.toLowerCase();
      if (skipKeys.some(sk => keyLower.includes(sk))) continue;

      if (typeof value === 'string' && value.length > 2) {
        const normalized = normalizeCommandContent(value);
        if (!normalized.startsWith('http') && !normalized.startsWith('$') &&
            !normalized.startsWith('Invoke-') && !normalized.includes('<HASH>') &&
            !normalized.includes('<TIMESTAMP>') && !normalized.includes('<BASE64>')) {
          coreValues.push(normalized.toLowerCase().trim());
        } else if (normalized.startsWith('http')) {
          try {
            const urlObj = new URL(normalized.replace(/<[^>]+>/g, ''));
            coreValues.push(urlObj.pathname.toLowerCase().trim());
          } catch {
            coreValues.push(normalized.toLowerCase().trim());
          }
        }
      }
    }

    return coreValues.join(' ');
  }

  /**
   * 计算两个字符串的简单相似度（Jaccard 词集合相似度）
   */
  similarity(s1, s2) {
    if (!s1 || !s2) return 0;
    const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
    if (words1.size === 0 && words2.size === 0) return 1;
    if (words1.size === 0 || words2.size === 0) return 0;
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    return intersection.size / union.size;
  }

  /**
   * 多层循环检测
   *
   * 第0层：请求内容哈希连续重复 - 同一哈希从末尾连续重复超过阈值
   * 第0.5层：请求内容哈希窗口频率（v6新增，解决交替式死循环）
   * 第1层：精确匹配（相同工具名 + 相同参数）
   * 第2层：工具名频率（同一工具在窗口内调用N次）
   * 第3层：语义相似度（同一工具 + 核心意图相似）
   * 第4层：全局频率（跨会话2分钟内大量调用）
   */
  detectLoop(sessionId, toolName, args) {
    if (!config.loopDetectionEnabled) return null;

    const argsStr = typeof args === 'string' ? args : JSON.stringify(args || {});

    // ── 第0层：请求内容哈希连续重复检测 ──
    const contentHash = hashTracker.computeHash(toolName, args);
    const consecutiveCount = hashTracker.countRecentRepeats(contentHash);
    const contentRepeatThreshold = config.loopDetectionContentRepeatThreshold || 10;

    if (consecutiveCount >= contentRepeatThreshold) {
      error(`第0层检测(内容哈希连续重复): 工具 ${toolName} 内容哈希 ${contentHash} 连续重复 ${consecutiveCount} 次 (阈值=${contentRepeatThreshold})`);
      return {
        toolName,
        args: argsStr,
        count: consecutiveCount,
        threshold: contentRepeatThreshold,
        layer: '内容哈希连续重复',
        contentHash,
        message: `检测到请求内容连续重复 ${consecutiveCount} 次！` +
          `工具 "${toolName}" 被反复调用，核心请求内容完全相同（已归一化时间戳/签名等易变内容）。` +
          '这是明确的死循环，已强制终止。',
      };
    }

    // ── 第0.5层：请求内容哈希窗口频率检测（v6新增） ──
    // 解决 OpenClaw 交替式死循环：A,B,A,B... 不连续但窗口内频繁出现
    const windowHashThreshold = config.loopDetectionWindowHashThreshold || 15;
    const windowCount = hashTracker.countInTimeWindow(contentHash);
    if (windowCount >= windowHashThreshold) {
      error(`第0.5层检测(窗口哈希频率): 工具 ${toolName} 内容哈希 ${contentHash} 在窗口内出现 ${windowCount} 次 (阈值=${windowHashThreshold})`);
      return {
        toolName,
        args: argsStr,
        count: windowCount,
        threshold: windowHashThreshold,
        layer: '窗口哈希频率',
        contentHash,
        message: `检测到请求内容在时间窗口内重复 ${windowCount} 次！` +
          `工具 "${toolName}" 被反复调用（虽然中间插入了其他调用，但核心内容相同的调用已达 ${windowCount} 次）。` +
          '这是典型的交替式死循环，已强制终止。',
      };
    }

    // ── 第1层：精确匹配 ──
    const history = this.getSessionHistory(sessionId);
    let exactCount = 0;
    for (const call of history) {
      if (call.toolName === toolName && call.args === argsStr) {
        exactCount++;
      }
    }
    exactCount++; // 加上当前这次

    if (exactCount >= config.loopDetectionThreshold) {
      log(`第1层检测(精确匹配): 工具 ${toolName} 精确重复 ${exactCount} 次`);
      return {
        toolName,
        args: argsStr,
        count: exactCount,
        threshold: config.loopDetectionThreshold,
        layer: '精确匹配',
        message: `检测到工具调用循环：${toolName} 已被连续调用 ${exactCount} 次（相同参数）。` +
          '请尝试不同的参数或换一种方式完成任务。',
      };
    }

    // ── 第2层：工具名频率检测 ──
    const freqHistory = this.getSessionToolFreq(sessionId);
    const recentWindow = freqHistory.slice(-config.loopDetectionWindowSize * 2);
    let toolNameCount = 0;
    for (const call of recentWindow) {
      if (call.toolName === toolName) toolNameCount++;
    }
    toolNameCount++; // 加上当前这次

    const toolNameThreshold = config.loopDetectionToolOnlyThreshold ||
      (config.loopDetectionThreshold + 2);

    if (toolNameCount >= toolNameThreshold) {
      log(`第2层检测(工具名频率): 工具 ${toolName} 在最近窗口内被调用 ${toolNameCount} 次（不同参数）`);
      return {
        toolName,
        args: argsStr,
        count: toolNameCount,
        threshold: toolNameThreshold,
        layer: '工具名频率',
        message: `检测到工具调用循环：${toolName} 在最近 ${recentWindow.length} 次调用中被使用了 ${toolNameCount} 次（参数不同但意图相同）。` +
          '模型可能陷入了尝试不同参数的死循环，请换一种策略。',
      };
    }

    // ── 第3层：语义相似度检测 ──
    const coreIntent = this.extractCoreIntent(args);
    if (coreIntent) {
      let similarCount = 0;
      const recentCalls = history.slice(-config.loopDetectionWindowSize * 2);
      for (const call of recentCalls) {
        if (call.toolName === toolName) {
          const callIntent = this.extractCoreIntent(call.args);
          if (callIntent && this.similarity(coreIntent, callIntent) > 0.5) {
            similarCount++;
          }
        }
      }
      similarCount++; // 加上当前这次

      const semanticThreshold = config.loopDetectionThreshold + 1;

      if (similarCount >= semanticThreshold) {
        log(`第3层检测(语义相似): 工具 ${toolName} 核心意图相似的调用 ${similarCount} 次`);
        return {
          toolName,
          args: argsStr,
          count: similarCount,
          threshold: semanticThreshold,
          layer: '语义相似',
          coreIntent,
          message: `检测到工具调用循环：${toolName} 的 ${similarCount} 次调用虽然参数不同，但核心意图相似。` +
            '模型正在用不同方式尝试同一操作，请换一种完全不同的方法。',
        };
      }
    }

    // ── 第4层：全局检测 ──
    const now = Date.now();
    const recentGlobal = this.globalCallSequence.filter(
      c => now - c.timestamp < 120000 && c.toolName === toolName
    );
    if (recentGlobal.length >= 10) {
      log(`第4层检测(全局频率): 工具 ${toolName} 在2分钟内被调用了 ${recentGlobal.length} 次（跨会话）`);
      return {
        toolName,
        args: argsStr,
        count: recentGlobal.length,
        threshold: 10,
        layer: '全局频率',
        message: `检测到全局工具调用过频：${toolName} 在2分钟内被调用了 ${recentGlobal.length} 次。可能存在死循环。`,
      };
    }

    return null;
  }

  /**
   * 获取会话已打断的次数
   */
  getBreakCount(sessionId) {
    return this.breakCounts.get(sessionId) || 0;
  }

  /**
   * 增加打断计数
   */
  incrementBreakCount(sessionId) {
    const count = this.getBreakCount(sessionId) + 1;
    this.breakCounts.set(sessionId, count);
    return count;
  }

  /**
   * 生成打破循环的干预消息
   */
  generateBreakMessage(loopInfo, breakCount) {
    // 第1次：强烈警告
    if (breakCount <= 1) {
      return {
        role: 'user',
        content: `[系统警告-循环检测] 检测到你陷入了循环！工具 "${loopInfo.toolName}" ` +
          `已经被连续调用 ${loopInfo.count} 次（检测方式: ${loopInfo.layer}）。` +
          '你必须立即停止重复调用该工具。不要再尝试不同的参数或不同的调用方式。\n' +
          '请直接用文字回复用户，说明你无法完成该操作以及原因。',
      };
    }

    // 第2次+：最强干预
    return {
      role: 'user',
      content: `[强制终止] 系统已检测到 ${breakCount} 次循环尝试，工具 "${loopInfo.toolName}" 仍在被反复调用。` +
        '当前任务已被强制终止。请立即输出你目前掌握的所有信息，然后结束任务。不要再调用任何工具。',
    };
  }

  /**
   * 清除会话历史
   */
  clearSession(sessionId) {
    this.sessionHistories.delete(sessionId);
    this.sessionToolFrequencies.delete(sessionId);
    this.sessionLastActive.delete(sessionId);
    this.breakCounts.delete(sessionId);
  }

  /**
   * 清除所有历史
   */
  clearAll() {
    this.sessionHistories.clear();
    this.sessionToolFrequencies.clear();
    this.sessionLastActive.clear();
    this.globalCallSequence = [];
    this.breakCounts.clear();
  }
}

// 全局单例
const loopDetector = new LoopDetector();

// 定期清理过期会话
setInterval(() => {
  loopDetector.cleanupStaleSessions();
}, 5 * 60 * 1000).unref();

// ═══════════════════════════════════════════════════════
//  消息历史扫描
// ═══════════════════════════════════════════════════════

/**
 * 扫描 openaiRequest.messages 中所有 assistant 消息的 tool_calls，
 * 统计每个工具被调用的次数。
 *
 * @param {object} openaiRequest - OpenAI 格式的请求
 * @param {number} threshold - 工具名频率阈值
 * @returns {object|null} 循环信息
 */
function scanMessageHistoryForLoops(openaiRequest, threshold) {
  const messages = openaiRequest.messages || [];

  const toolCallCounts = {};
  const recentToolCalls = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const toolName = tc.function?.name;
        if (toolName) {
          toolCallCounts[toolName] = (toolCallCounts[toolName] || 0) + 1;
        }
      }
      recentToolCalls.push(...msg.tool_calls);
    }
  }

  // 检查是否有工具超过阈值
  for (const [toolName, count] of Object.entries(toolCallCounts)) {
    if (count >= threshold) {
      log(`消息历史扫描: 工具 ${toolName} 在对话历史中出现了 ${count} 次 (阈值=${threshold})`);
      return {
        toolName,
        count,
        threshold,
        layer: '消息历史扫描',
        message: `消息历史中有 ${count} 次对 ${toolName} 的调用（阈值=${threshold}），已构成死循环。`,
      };
    }
  }

  // v6修复: 检查最近N条tool_calls是否同一工具占比过高
  // 之前只检查"最近N条全部是同一工具"，现在检查"最近M条中有N条是同一工具"
  const lookbackSize = Math.max(threshold * 3, 30);
  const recentOnly = recentToolCalls.slice(-lookbackSize);
  if (recentOnly.length >= threshold) {
    const toolNameCounts = {};
    for (const tc of recentOnly) {
      const name = tc.function?.name;
      if (name) toolNameCounts[name] = (toolNameCounts[name] || 0) + 1;
    }
    // 检查是否有工具占比超过50%且绝对数量超过阈值
    for (const [toolName, count] of Object.entries(toolNameCounts)) {
      const ratio = count / recentOnly.length;
      if (count >= threshold * 2 && ratio > 0.5) {
        log(`最近调用占比扫描: 最近${recentOnly.length}次调用中，${toolName}占${count}次(${(ratio*100).toFixed(0)}%)`);
        return {
          toolName,
          count,
          threshold: threshold * 2,
          layer: '最近调用占比',
          message: `最近 ${recentOnly.length} 次工具调用中，${toolName} 被调用了 ${count} 次（占比${(ratio*100).toFixed(0)}%），这是典型的死循环。`,
        };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════
//  主入口函数
// ═══════════════════════════════════════════════════════

/**
 * 检查 OpenAI 请求中的工具调用是否存在循环
 *
 * v6 检测流程（按优先级）：
 * 1. 请求内容哈希连续重复检测（全局，真正连续检测）
 * 2. 请求内容哈希窗口频率检测（v6新增，解决交替式死循环）
 * 3. 消息历史扫描（直接看messages中有多少次重复调用）
 * 4. 会话级多层检测（精确/频率/语义）
 */
function checkRequestForLoop(openaiRequest, sessionId) {
  if (!config.loopDetectionEnabled) {
    return { isLoop: false, breakMessage: null, breakAction: null, breakCount: 0, modifiedRequest: openaiRequest };
  }

  const messages = openaiRequest.messages || [];
  const contentRepeatThreshold = config.loopDetectionContentRepeatThreshold || 10;
  const windowHashThreshold = config.loopDetectionWindowHashThreshold || 15;

  // 找到最后一个 assistant 消息中的 tool_calls
  let lastToolCalls = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      lastToolCalls = msg.tool_calls;
      break;
    }
  }

  if (lastToolCalls.length === 0) {
    return { isLoop: false, breakMessage: null, breakAction: null, breakCount: 0, modifiedRequest: openaiRequest };
  }

  // ═══════════════════════════════════════════════════════
  //  优先级1：请求内容哈希连续重复检测
  // ═══════════════════════════════════════════════════════
  for (const tc of lastToolCalls) {
    const toolName = tc.function?.name;
    const args = tc.function?.arguments;
    if (!toolName) continue;

    const contentHash = hashTracker.computeHash(toolName, args);
    hashTracker.record(toolName, args, contentHash);

    const consecutiveCount = hashTracker.countRecentRepeats(contentHash);

    log(`哈希追踪: 工具=${toolName}, 哈希=${contentHash}, 连续重复=${consecutiveCount}/${contentRepeatThreshold}`);

    if (consecutiveCount >= contentRepeatThreshold) {
      error(`内容哈希连续重复触发! 工具=${toolName}, 哈希=${contentHash}, 连续重复=${consecutiveCount}次`);

      const loopInfo = {
        toolName,
        args: typeof args === 'string' ? args : JSON.stringify(args || {}),
        count: consecutiveCount,
        threshold: contentRepeatThreshold,
        layer: '内容哈希连续重复',
        contentHash,
        message: `请求内容连续重复 ${consecutiveCount} 次！工具 "${toolName}" 被反复调用，核心内容完全相同。已强制终止死循环。`,
      };

      const breakCount = loopDetector.incrementBreakCount(sessionId);

      return {
        isLoop: true,
        loopInfo,
        breakMessage: loopDetector.generateBreakMessage(loopInfo, breakCount),
        breakAction: 'force_end',
        breakCount,
        modifiedRequest: openaiRequest,
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  优先级1.5：请求内容哈希窗口频率检测（v6新增）
  //  解决 OpenClaw 交替式死循环：A,B,A,B...
  // ═══════════════════════════════════════════════════════
  for (const tc of lastToolCalls) {
    const toolName = tc.function?.name;
    const args = tc.function?.arguments;
    if (!toolName) continue;

    const contentHash = hashTracker.computeHash(toolName, args);
    const windowCount = hashTracker.countInTimeWindow(contentHash);

    log(`窗口频率: 工具=${toolName}, 哈希=${contentHash}, 窗口内=${windowCount}/${windowHashThreshold}`);

    if (windowCount >= windowHashThreshold) {
      error(`窗口哈希频率触发! 工具=${toolName}, 哈希=${contentHash}, 窗口内=${windowCount}次`);

      const loopInfo = {
        toolName,
        args: typeof args === 'string' ? args : JSON.stringify(args || {}),
        count: windowCount,
        threshold: windowHashThreshold,
        layer: '窗口哈希频率',
        contentHash,
        message: `请求内容在时间窗口内重复 ${windowCount} 次！工具 "${toolName}" 被反复调用（交替式死循环）。已强制终止。`,
      };

      const breakCount = loopDetector.incrementBreakCount(sessionId);

      return {
        isLoop: true,
        loopInfo,
        breakMessage: loopDetector.generateBreakMessage(loopInfo, breakCount),
        breakAction: breakCount >= 2 ? 'force_end' : 'strip_tools',
        breakCount,
        modifiedRequest: breakCount >= 2 ? openaiRequest : {
          ...openaiRequest,
          messages: [...openaiRequest.messages, loopDetector.generateBreakMessage(loopInfo, breakCount)],
          tools: [],
          tool_choice: 'none',
        },
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  优先级2：消息历史扫描
  // ═══════════════════════════════════════════════════════
  const historyThreshold = Math.min(contentRepeatThreshold, 20);
  const historyLoopInfo = scanMessageHistoryForLoops(openaiRequest, historyThreshold);
  if (historyLoopInfo) {
    const breakCount = loopDetector.incrementBreakCount(sessionId);
    const breakMessage = loopDetector.generateBreakMessage(historyLoopInfo, breakCount);

    let breakAction = 'inject_message';
    let modifiedRequest = { ...openaiRequest, messages: [...openaiRequest.messages, breakMessage] };

    if (breakCount >= 1) {
      breakAction = 'strip_tools';
      modifiedRequest = {
        ...openaiRequest,
        messages: [...openaiRequest.messages, breakMessage],
        tools: [],
        tool_choice: 'none',
      };
      log(`剥离工具定义，强制文本回复 (第${breakCount}次打断)`);
    }

    if (breakCount >= 2) {
      breakAction = 'force_end';
      log(`强制终止 (第${breakCount}次打断)`);
    }

    return {
      isLoop: true,
      loopInfo: historyLoopInfo,
      breakMessage,
      breakAction,
      breakCount,
      modifiedRequest,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  优先级3：会话级多层检测
  // ═══════════════════════════════════════════════════════
  for (const tc of lastToolCalls) {
    const toolName = tc.function?.name;
    const args = tc.function?.arguments;
    if (!toolName) continue;

    // 先检测，再记录
    const loopInfo = loopDetector.detectLoop(sessionId, toolName, args);
    loopDetector.recordCall(sessionId, toolName, args);

    if (loopInfo) {
      const breakCount = loopDetector.incrementBreakCount(sessionId);
      const breakMessage = loopDetector.generateBreakMessage(loopInfo, breakCount);

      let breakAction = 'inject_message';
      let modifiedRequest = { ...openaiRequest, messages: [...openaiRequest.messages, breakMessage] };

      if (breakCount >= 1) {
        breakAction = 'strip_tools';
        modifiedRequest = {
          ...openaiRequest,
          messages: [...openaiRequest.messages, breakMessage],
          tools: [],
          tool_choice: 'none',
        };
        log(`剥离工具定义 (第${breakCount}次打断)`);
      }

      if (breakCount >= 2) {
        breakAction = 'force_end';
        log(`强制终止 (第${breakCount}次打断)`);
      }

      return {
        isLoop: true,
        loopInfo,
        breakMessage,
        breakAction,
        breakCount,
        modifiedRequest,
      };
    }
  }

  return { isLoop: false, breakMessage: null, breakAction: null, breakCount: 0, modifiedRequest: openaiRequest };
}

/**
 * 检查 OpenAI 响应中的工具调用是否存在循环
 * v6增强：新增响应内容重复检测
 */
function checkResponseForLoop(openaiResponse, sessionId) {
  const toolCalls = openaiResponse?.choices?.[0]?.message?.tool_calls;
  const responseContent = openaiResponse?.choices?.[0]?.message?.content;
  const isToolCall = !!(toolCalls && toolCalls.length > 0);

  // ═══════════════════════════════════════════════════════
  //  R0: 响应内容重复检测（v6新增）
  //  当模型反复生成相同的纯文本响应时，说明卡住了
  // ═══════════════════════════════════════════════════════
  const responseRepeatThreshold = config.loopDetectionResponseRepeatThreshold || 5;
  const responseHash = responseHashTracker.record(responseContent, isToolCall);

  if (responseHash) {
    const consecutiveCount = responseHashTracker.countRecentRepeats(responseHash);

    if (consecutiveCount >= responseRepeatThreshold) {
      error(`响应内容重复检测触发! 哈希=${responseHash}, 连续重复=${consecutiveCount}次, 阈值=${responseRepeatThreshold}`);

      const preview = responseContent ? responseContent.substring(0, 80) : '(空)';
      const loopInfo = {
        toolName: '(响应内容)',
        args: preview,
        count: consecutiveCount,
        threshold: responseRepeatThreshold,
        layer: '响应内容重复',
        contentHash: responseHash,
        message: `检测到响应内容连续重复 ${consecutiveCount} 次！模型反复生成相同的内容："${preview}..."。这表明模型已卡住，需要干预。`,
      };

      loopDetector.incrementBreakCount(sessionId);
      return { isLoop: true, loopInfo };
    }

    // v6: 也检查窗口频率
    const windowCount = responseHashTracker.countInTimeWindow(responseHash);
    const windowThreshold = Math.max(responseRepeatThreshold * 2, 10);
    if (windowCount >= windowThreshold) {
      error(`响应内容窗口频率触发! 哈希=${responseHash}, 窗口内=${windowCount}次, 阈值=${windowThreshold}`);

      const preview = responseContent ? responseContent.substring(0, 80) : '(空)';
      const loopInfo = {
        toolName: '(响应内容)',
        args: preview,
        count: windowCount,
        threshold: windowThreshold,
        layer: '响应内容窗口频率',
        contentHash: responseHash,
        message: `检测到响应内容在时间窗口内重复 ${windowCount} 次！模型反复生成相同的内容。`,
      };

      loopDetector.incrementBreakCount(sessionId);
      return { isLoop: true, loopInfo };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  工具调用循环检测
  // ═══════════════════════════════════════════════════════
  if (!toolCalls || toolCalls.length === 0) {
    return { isLoop: false, loopInfo: null };
  }

  for (const tc of toolCalls) {
    const toolName = tc.function?.name;
    const args = tc.function?.arguments;
    if (toolName) {
      const loopInfo = loopDetector.detectLoop(sessionId, toolName, args);
      if (loopInfo) {
        loopDetector.incrementBreakCount(sessionId);
        return { isLoop: true, loopInfo };
      }
    }
  }

  return { isLoop: false, loopInfo: null };
}

/**
 * 带诊断报告的请求循环检测
 */
function checkRequestForLoopWithReport(openaiRequest, sessionId, diag) {
  const result = checkRequestForLoop(openaiRequest, sessionId);

  const messages = openaiRequest.messages || [];
  let lastToolCalls = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls) {
      lastToolCalls = messages[i].tool_calls;
      break;
    }
  }

  // 统计消息历史中的工具调用次数
  const toolCounts = {};
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        if (name) toolCounts[name] = (toolCounts[name] || 0) + 1;
      }
    }
  }
  const toolCountStr = Object.entries(toolCounts).map(([n, c]) => `${n}(${c}次)`).join(', ');

  if (lastToolCalls.length > 0) {
    const toolNames = lastToolCalls.map(tc => tc.function?.name).join(', ');
    diag.phase('循环检测(请求)', `最近调用: [${toolNames}], 历史统计: {${toolCountStr}}`);
  } else {
    diag.phase('循环检测(请求)', '历史中无工具调用');
  }

  // 输出哈希追踪器状态
  const hashStats = hashTracker.getStats();
  if (hashStats.totalTracked > 0) {
    diag.stat('请求哈希追踪', `${hashStats.totalTracked}条记录`);
  }

  // 输出响应哈希追踪器状态
  const respHashStats = responseHashTracker.getStats();
  if (respHashStats.totalTracked > 0) {
    diag.stat('响应哈希追踪', `${respHashStats.totalTracked}条记录`);
  }

  if (result.isLoop) {
    diag.issue('循环检测器',
      `检测到死循环! [${result.loopInfo.layer}] ${result.loopInfo.toolName} 重复 ${result.loopInfo.count} 次 (干预级别: ${result.breakAction})`,
      'error');
    diag.fix('循环检测器', '原请求', result.breakAction,
      `第${result.breakCount}次干预: ${result.breakAction === 'inject_message' ? '注入中断消息' :
        result.breakAction === 'strip_tools' ? '剥离工具定义+强制文本' :
        '强制终止'}`);
  }

  return result;
}

/**
 * 带诊断报告的响应循环检测
 */
function checkResponseForLoopWithReport(openaiResponse, sessionId, diag) {
  const result = checkResponseForLoop(openaiResponse, sessionId);

  const toolCalls = openaiResponse?.choices?.[0]?.message?.tool_calls;
  const responseContent = openaiResponse?.choices?.[0]?.message?.content;

  if (toolCalls && toolCalls.length > 0) {
    const toolNames = toolCalls.map(tc => tc.function?.name).join(', ');
    diag.phase('循环检测(响应)', `模型请求调用: [${toolNames}]`);
  } else if (responseContent) {
    const contentPreview = responseContent.substring(0, 50);
    diag.phase('循环检测(响应)', `纯文本回复: "${contentPreview}..."`);
  } else {
    diag.phase('循环检测(响应)', '模型未请求工具调用');
  }

  if (result.isLoop) {
    diag.issue('循环检测器', `响应中检测到循环: ${result.loopInfo.message}`, 'error');
  }

  return result;
}

/**
 * 创建一个强制终止的 Anthropic 响应（用于 breakAction='force_end'）
 */
function createForceEndResponse(model) {
  return {
    id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '[适配器强制终止] 检测到工具调用陷入无法恢复的死循环，已强制结束当前任务。' +
          '请检查：\n1. LM Studio 模型是否支持工具调用\n2. 工具定义格式是否正确\n3. 模型的 max_tokens 设置是否足够\n4. 目标 skill 服务是否正常响应',
      },
    ],
    model: model || 'local-model',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

module.exports = {
  LoopDetector,
  loopDetector,
  hashTracker,
  responseHashTracker,
  RequestHashTracker,
  ResponseHashTracker,
  checkRequestForLoop,
  checkResponseForLoop,
  checkRequestForLoopWithReport,
  checkResponseForLoopWithReport,
  createForceEndResponse,
  scanMessageHistoryForLoops,
  normalizeCommandContent,
  normalizeArgsObject,
};
