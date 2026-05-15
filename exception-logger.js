/**
 * 异常调用日志模块 v6 - 持久化记录适配器异常和 OpenClaw 异常终止事件
 *
 * v6 增强：
 * - 新增响应内容重复事件记录
 * - 新增窗口哈希频率事件记录
 * - 修复关键日志未被正确写入文件的bug（确保每条日志都 flush）
 * - 保留 v5 所有增强
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// ─── 日志目录 ───
const LOG_DIR = path.join(__dirname, 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (e) {
      console.error('[异常日志] 创建日志目录失败:', e.message);
    }
  }
}

// 启动时确保日志目录存在
ensureLogDir();

// ─── 日志级别 ───
const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
};

// ─── 关键类别：始终输出到控制台 ───
const ALWAYS_CONSOLE_CATEGORIES = new Set([
  'loop',                  // 循环检测
  'abort',                 // 客户端断开
  'finish_reason',         // finish_reason异常
  'connection',            // 连接错误
  'summary',               // 请求摘要
  'content_hash_repeat',   // 内容哈希重复
  'response_hash_repeat',  // 响应内容哈希重复（v6新增）
  'window_hash_repeat',    // 窗口哈希频率（v6新增）
  'response',              // 响应异常
  'protocol',              // 协议异常
  'language',              // 语言修正
]);

// ─── 当前日志文件 ───
function getLogFilePath() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  return path.join(LOG_DIR, `adapter-${dateStr}.log`);
}

function timestamp() {
  return new Date().toISOString();
}

/**
 * 写入一行日志到文件
 * v5修复：使用 writeFileSync 替代 appendFile
 * 之前 appendFile 是异步的，在进程崩溃或事件循环繁忙时会丢失日志
 */
function writeToFile(line) {
  if (!config.exceptionLogToFile) return;

  try {
    ensureLogDir();
    const logFile = getLogFilePath();
    fs.appendFileSync(logFile, line + '\n', 'utf-8');

    // 检查文件大小，超过10MB轮转
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > 10 * 1024 * 1024) {
        const rotated = logFile.replace('.log', `-${Date.now()}.log`);
        // Windows 兼容: renameSync 在目标文件已存在时会失败
        // 轮转场景中目标文件不应存在，但为安全起见先尝试删除
        try { fs.unlinkSync(rotated); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        fs.renameSync(logFile, rotated);
      }
    } catch { /* 忽略 stat 失败 */ }
  } catch (err) {
    // 写入失败只输出一次，避免无限循环
    console.error('[异常日志] 写入失败:', err.message);
  }
}

/**
 * 记录一条异常日志
 * v5: 关键类别始终输出到控制台
 */
function log(level, category, requestId, sessionId, message, details = null) {
  if (LEVELS[level] === undefined) level = 'info';

  const entry = {
    timestamp: timestamp(),
    level,
    category,
    requestId: requestId || '-',
    sessionId: sessionId || '-',
    message,
  };

  if (details) {
    entry.details = details;
  }

  const line = JSON.stringify(entry);
  writeToFile(line);

  // 控制台输出策略：
  // 1. 关键类别始终输出
  // 2. error/warn 级别始终输出
  // 3. info级别只在 DEBUG_LOGGING=true 时输出
  const shouldConsole = ALWAYS_CONSOLE_CATEGORIES.has(category) ||
    level === 'error' || level === 'warn' ||
    config.debugLogging;

  if (shouldConsole) {
    const prefix = `[异常日志] [${level.toUpperCase()}] [${category}]`;
    if (level === 'error') {
      console.error(prefix, `[${requestId}]`, message);
    } else if (level === 'warn') {
      console.warn(prefix, `[${requestId}]`, message);
    } else {
      console.log(prefix, `[${requestId}]`, message);
    }
  }
}

function logClientAbort(requestId, sessionId, reason, context = null) {
  log('error', 'abort', requestId, sessionId,
    `OpenClaw 异常断开: ${reason}`,
    { reason, ...context }
  );
}

function logBadResponse(requestId, sessionId, issue, responseData = null) {
  log('error', 'response', requestId, sessionId,
    `LM Studio 异常响应: ${issue}`,
    { issue, responseSummary: responseData ? summarizeResponse(responseData) : null }
  );
}

function logProtocolError(requestId, sessionId, issue, details = null) {
  log('error', 'protocol', requestId, sessionId,
    `协议转换异常: ${issue}`,
    details
  );
}

function logTimeout(requestId, sessionId, phase, elapsed) {
  log('warn', 'timeout', requestId, sessionId,
    `超时事件: ${phase}阶段超时 (${elapsed}ms)`,
    { phase, elapsed }
  );
}

function logLoopDetected(requestId, sessionId, toolName, count) {
  log('warn', 'loop', requestId, sessionId,
    `循环检测触发: 工具 ${toolName} 已重复调用 ${count} 次`,
    { toolName, count }
  );
}

/**
 * v4新增：记录内容哈希重复事件
 */
function logContentHashRepeat(requestId, sessionId, toolName, contentHash, repeatCount) {
  log('error', 'content_hash_repeat', requestId, sessionId,
    `请求内容哈希连续重复 ${repeatCount} 次! 工具=${toolName}, 哈希=${contentHash}`,
    { toolName, contentHash, repeatCount }
  );
}

/**
 * v5新增：记录语言修正事件
 */
function logLanguageFix(requestId, sessionId, detectedLang, targetLang) {
  log('info', 'language', requestId, sessionId,
    `响应语言修正: 检测到${detectedLang}, 修正为${targetLang}`,
    { detectedLang, targetLang }
  );
}

/**
 * v6新增：记录响应内容哈希重复事件
 */
function logResponseHashRepeat(requestId, sessionId, contentHash, repeatCount, preview) {
  log('error', 'response_hash_repeat', requestId, sessionId,
    `响应内容哈希连续重复 ${repeatCount} 次! 哈希=${contentHash}, 预览="${(preview || '').substring(0, 50)}"`,
    { contentHash, repeatCount, preview: (preview || '').substring(0, 100) }
  );
}

/**
 * v6新增：记录窗口哈希频率事件
 */
function logWindowHashRepeat(requestId, sessionId, toolName, contentHash, windowCount) {
  log('error', 'window_hash_repeat', requestId, sessionId,
    `窗口哈希频率触发! 工具=${toolName}, 哈希=${contentHash}, 窗口内=${windowCount}次`,
    { toolName, contentHash, windowCount }
  );
}

function logFinishReason(requestId, sessionId, finishReason, context = null) {
  const level = (finishReason === 'length' || finishReason === 'content_filter') ? 'warn' : 'info';
  log(level, 'finish_reason', requestId, sessionId,
    `finish_reason=${finishReason}${finishReason === 'length' ? ' (可能导致任务提前终止)' : ''}`,
    { finishReason, ...context }
  );
}

/**
 * 请求摘要始终输出到控制台
 */
function logRequestSummary(requestId, sessionId, summary) {
  log('info', 'summary', requestId, sessionId,
    `请求处理完成: ${summary.description || 'ok'}`,
    summary
  );
}

function summarizeResponse(data) {
  if (!data) return null;
  try {
    const choice = data.choices?.[0];
    return {
      finish_reason: choice?.finish_reason,
      has_tool_calls: !!(choice?.message?.tool_calls?.length),
      tool_call_count: choice?.message?.tool_calls?.length || 0,
      content_length: choice?.message?.content?.length || 0,
      usage: data.usage,
    };
  } catch {
    return { error: '无法解析响应' };
  }
}

function queryLogs(filter = {}, limit = 50) {
  limit = Math.min(Math.max(1, limit), 200);
  try {
    ensureLogDir();
    const logFile = getLogFilePath();
    if (!fs.existsSync(logFile)) return [];

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let entries = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (filter.level) entries = entries.filter(e => e.level === filter.level);
    if (filter.category) entries = entries.filter(e => e.category === filter.category);
    if (filter.sessionId) entries = entries.filter(e => e.sessionId === filter.sessionId);
    if (filter.requestId) entries = entries.filter(e => e.requestId === filter.requestId);

    return entries.slice(-limit);
  } catch {
    return [];
  }
}

function getStats() {
  try {
    ensureLogDir();
    const logFile = getLogFilePath();
    if (!fs.existsSync(logFile)) return { total: 0, today: getLogFilePath() };

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const stats = { total: lines.length, errors: 0, warnings: 0, byCategory: {} };

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.level === 'error') stats.errors++;
        if (entry.level === 'warn') stats.warnings++;
        stats.byCategory[entry.category] = (stats.byCategory[entry.category] || 0) + 1;
      } catch { /* 忽略 */ }
    }

    return stats;
  } catch {
    return { total: 0 };
  }
}

module.exports = {
  log,
  logClientAbort,
  logBadResponse,
  logProtocolError,
  logTimeout,
  logLoopDetected,
  logContentHashRepeat,
  logResponseHashRepeat,
  logWindowHashRepeat,
  logLanguageFix,
  logFinishReason,
  logRequestSummary,
  queryLogs,
  getStats,
  LOG_DIR,
};
