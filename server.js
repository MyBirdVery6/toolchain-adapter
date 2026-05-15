/**
 * Toolchain Adapter - 主服务入口（v8 Windows 专用版）
 *
 * OpenClaw (Anthropic 格式) → 适配器 (端口 3838) → LM Studio / llama.cpp
 *
 * 端点：
 *   POST /v1/messages          - Anthropic Messages API 兼容端点（主端点）
 *   POST /v1/chat/completions  - OpenAI 兼容端点（次端点）
 *   GET  /v1/models            - 列出可用模型
 *   GET  /health               - 健康检查
 *   GET  /logs                 - 查询异常日志
 *   GET  /memory               - 查询记忆存储状态
 *   DELETE /memory/:sessionId  - 删除指定会话记忆
 *
 * v7 关键增强：
 *   - 多后端支持：LM Studio + llama.cpp 服务器深度适配
 *   - SSD 永久记忆存储：防止项目失忆，关键事实持久化到硬盘
 *   - 上下文自动提炼：压缩前提取关键事实，跨会话保留
 *   - 保留所有 v6 修复：交替式死循环检测、响应重复检测、语言修正
 */

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { createReport } = require('./diagnostic');
const {
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  StreamConverter,
} = require('./protocol-converter');
const { repairResponseToolCallsWithReport } = require('./json-repair');
const { compressContextWithReport, estimateTokens } = require('./context-compressor');
const { injectFewShotWithReport } = require('./few-shot-injector');
const { checkRequestForLoopWithReport, checkResponseForLoopWithReport, createForceEndResponse } = require('./loop-detector');
const { fixSimulatedCallsWithReport } = require('./simulated-call-fixer');
const { injectLanguageInstruction, fixResponseLanguage } = require('./language-fixer');
const excLogger = require('./exception-logger');

// ─── v7: 多后端 + 记忆存储 + 上下文提炼 ───
const { createBackend } = require('./backend-adapter');
const { MemoryStore } = require('./memory-store');
const { refineContext } = require('./context-refiner');

// ─── 初始化后端适配器 ───
const backendConfig = {
  baseUrl: config.backendType === 'llamacpp' ? config.llamacppBaseUrl : config.lmStudioBaseUrl,
  timeout: config.lmStudioTimeout,
};
if (config.backendType === 'llamacpp') {
  backendConfig.cache_prompt = config.llamacppCachePrompt;
  if (config.llamacppReasoningFormat) backendConfig.reasoning_format = config.llamacppReasoningFormat;
}
const backend = createBackend(config.backendType, backendConfig);

// ─── 初始化记忆存储 ───
const memoryStoreDir = config.memoryStoreDir || __dirname;
const memoryStore = config.memoryStoreEnabled ? new MemoryStore(memoryStoreDir) : null;

// 定期清理过期记忆（每小时）
if (memoryStore) {
  setInterval(() => {
    memoryStore.cleanup(config.memoryCleanupMaxAge).then(count => {
      if (count > 0) console.log(`[记忆存储] 清理了 ${count} 个过期会话`);
    }).catch(() => {});
  }, 60 * 60 * 1000).unref();
}

// ═══════════════════════════════════════════════════════
//  启动横幅
// ═══════════════════════════════════════════════════════

console.log('');
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║     Toolchain Adapter v8 - Windows 工具调用协议适配器       ║');
console.log(`║     OpenClaw/Claude Code ↔ ${backend.getName().padEnd(28)}║`);
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`  适配器端口:     ${config.adapterPort}`);
console.log(`  后端类型:       ${backend.getName()}`);
console.log(`  后端 URL:       ${backend.getBaseUrl()}`);
console.log(`  模型覆盖:       ${config.modelOverride || '(使用请求中的模型名)'}`);
console.log(`  默认模型:       ${config.defaultModel}`);
console.log(`  循环检测:       ${config.loopDetectionEnabled ? '✓ 开启' : '✗ 关闭'} (精确=${config.loopDetectionThreshold}, 工具名=${config.loopDetectionToolOnlyThreshold}, 内容连续=${config.loopDetectionContentRepeatThreshold}, 窗口频率=${config.loopDetectionWindowHashThreshold}, 响应重复=${config.loopDetectionResponseRepeatThreshold})`);
console.log(`  Few-Shot注入:   ${config.fewShotEnabled ? '✓ 开启' : '✗ 关闭'}`);
console.log(`  JSON修复:       ${config.jsonRepairEnabled ? '✓ 开启' : '✗ 关闭'}`);
console.log(`  模拟调用修复:   ${config.simulatedCallFixerEnabled ? '✓ 开启' : '✗ 关闭'}`);
console.log(`  响应语言:       ${config.responseLanguage || '(不修正)'} (修正=${config.responseLanguageFixEnabled ? '✓' : '✗'})`);
console.log(`  诊断日志:       ${config.diagnosticLogging ? '✓ 开启' : '✗ 关闭'} (文件持久化=${config.diagnosticLogToFile ? '✓' : '✗'})`);
console.log(`  调试日志:       ${config.debugLogging ? '✓ 开启' : '✗ 关闭'}`);
console.log(`  记忆存储:       ${memoryStore ? '✓ 开启' : '✗ 关闭'} (目录=${memoryStoreDir}/memory/)`);
console.log(`  上下文提炼:     ${config.contextRefinerEnabled ? '✓ 开启' : '✗ 关闭'}`);
console.log('');

// ─── Express 应用 ───
const app = express();
app.use(express.json({ limit: config.maxRequestSize }));
app.use(express.urlencoded({ extended: true }));

// ─── 活跃请求追踪 ───
const activeRequests = new Map();

// ─── 会话ID持久化映射（用于解决sessionId不连续问题） ───
// 通过指纹匹配（最近的消息内容前100字符+工具名列表）关联同一会话的请求
const sessionFingerprints = new Map();

/**
 * 计算请求的会话指纹（用于跨请求识别同一会话）
 * v4 修复：使用消息数量+系统提示哈希+工具名列表 作为指纹
 *
 * v3 的bug：使用 messages.slice(-2) 导致对话增长时指纹变化，
 * 每次请求生成新的 sessionId，循环检测的会话历史永远无法积累
 *
 * v4 修复策略：使用稳定的指纹因素
 * - 消息总数（同一会话的消息数随对话增长，但不会突变）
 * - 系统提示的哈希（同一会话系统提示通常不变）
 * - 工具名列表（同一会话工具集通常不变）
 * - 第一条user消息的前100字符（锚定对话主题）
 */
function computeSessionFingerprint(reqBody) {
  const messages = reqBody.messages || [];
  const tools = reqBody.tools || [];
  const parts = [];

  // v4修复: 不再包含 msgCount，因为它随对话增长导致指纹不稳定
  // 使用稳定的因素：第一条user消息 + 系统提示 + 工具名列表

  // 第一条user消息的内容（对话主题锚定，同一会话中不会变）
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content :
        Array.isArray(msg.content) ? msg.content.map(b => b.text || b.type || '').join('') : '';
      parts.push(`firstUser:${content.substring(0, 100)}`);
      break;
    }
  }

  // 系统提示的哈希
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg) {
    const sysContent = typeof systemMsg.content === 'string' ? systemMsg.content :
      JSON.stringify(systemMsg.content || '');
    // 简单哈希：取前200字符
    parts.push(`sys:${sysContent.substring(0, 200)}`);
  }

  // 工具名列表（同一会话工具集通常不变）
  const toolNames = tools.map(t => t.name || t.function?.name || '').filter(Boolean).sort().join(',');
  parts.push(`tools:${toolNames}`);

  return parts.join('|');
}

/**
 * 获取稳定的会话ID
 * 优先使用请求中的sessionId，否则通过指纹匹配
 */
function getStableSessionId(req) {
  // 1. 优先使用请求头中的会话ID
  const headerSession = req.headers['x-session-id'];
  if (headerSession && headerSession.length > 2) return headerSession;

  // 2. 使用请求体中的会话ID
  const bodySession = req.body?.metadata?.session_id;
  if (bodySession && bodySession.length > 2) return bodySession;

  // 3. 通过指纹匹配
  const fingerprint = computeSessionFingerprint(req.body || {});
  if (sessionFingerprints.has(fingerprint)) {
    return sessionFingerprints.get(fingerprint);
  }

  // 4. 生成新的会话ID
  const newSessionId = `sess_${uuidv4().slice(0, 8)}`;
  sessionFingerprints.set(fingerprint, newSessionId);

  // 定期清理过期指纹
  if (sessionFingerprints.size > 1000) {
    const entries = [...sessionFingerprints.entries()];
    sessionFingerprints.clear();
    // 保留最近500条
    for (const [k, v] of entries.slice(-500)) {
      sessionFingerprints.set(k, v);
    }
  }

  return newSessionId;
}

// ─── 请求日志中间件 ───
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = uuidv4().slice(0, 8);

  req.requestId = requestId;
  req.startTime = start;
  req.streamCompleted = false; // v3: 跟踪流式响应是否正常完成

  activeRequests.set(requestId, {
    method: req.method,
    path: req.path,
    startTime: start,
    sessionId: null,
  });

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    // 始终输出请求完成日志
    console.log(
      `[${level}] [${requestId}] ${req.method} ${req.path} → ${status} (${duration}ms)`
    );
    activeRequests.delete(requestId);
  });

  next();
});

// ─── CORS 支持 ───
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ═══════════════════════════════════════════════════════
//  POST /v1/messages - Anthropic Messages API 兼容端点
// ═══════════════════════════════════════════════════════

app.post('/v1/messages', async (req, res) => {
  const requestId = req.requestId;
  const sessionId = getStableSessionId(req); // v3: 使用稳定的会话ID
  const diag = createReport(requestId);

  // 更新活跃请求的会话ID
  const activeReq = activeRequests.get(requestId);
  if (activeReq) activeReq.sessionId = sessionId;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Anthropic] [${requestId}] 收到请求，会话: ${sessionId}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    const anthropicRequest = req.body;

    // 参数验证
    if (!anthropicRequest.messages || !Array.isArray(anthropicRequest.messages)) {
      excLogger.logProtocolError(requestId, sessionId, '请求缺少 messages 字段');
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages 字段必须是非空数组' },
      });
    }

    // ── 原始请求分析 ──
    const origMsgCount = anthropicRequest.messages.length;
    const origTools = anthropicRequest.tools || [];
    const origSystem = anthropicRequest.system ? '有' : '无';
    const origStream = anthropicRequest.stream ? '流式' : '非流式';
    diag.stat('原始请求', `消息=${origMsgCount}, 工具=${origTools.length}, 系统提示=${origSystem}, 模式=${origStream}`);

    // ── 步骤1：协议转换 Anthropic → OpenAI ──
    let openaiRequest = convertAnthropicToOpenAI(anthropicRequest);
    diag.phase('协议转换(请求)', `Anthropic → OpenAI: ${origMsgCount}条消息 → ${openaiRequest.messages.length}条消息, ${origTools.length}个工具转换完成`);

    // 检查是否有 tool_use 内容块需要转换
    let toolUseBlocks = 0;
    let toolResultBlocks = 0;
    for (const msg of anthropicRequest.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') toolUseBlocks++;
          if (block.type === 'tool_result') toolResultBlocks++;
        }
      }
    }
    if (toolUseBlocks > 0 || toolResultBlocks > 0) {
      diag.fix('协议转换器', 'Anthropic content blocks', 'OpenAI tool_calls/tool messages',
        `转换了 ${toolUseBlocks} 个 tool_use 块, ${toolResultBlocks} 个 tool_result 块`);
    }

    // ── 步骤1.5：分析请求中的潜在问题 ──
    analyzeRequestIssues(openaiRequest, diag);

    // ── 步骤1.7：上下文提炼（v7新增，在压缩前提取关键事实） ──
    if (config.contextRefinerEnabled && memoryStore) {
      try {
        const refineResult = await refineContext(openaiRequest, sessionId, memoryStore);
        if (refineResult.refined) {
          openaiRequest = refineResult.request;
          diag.phase('上下文提炼', `提取了${refineResult.factsExtracted}个关键事实并保存到记忆存储`);
          diag.fix('上下文提炼', '原始上下文', `提炼${refineResult.factsExtracted}个事实+注入记忆`, '防止压缩导致项目失忆');
        } else {
          // 即使不需要提炼，也加载已有记忆注入
          if (refineResult.request !== openaiRequest) {
            openaiRequest = refineResult.request;
            diag.phase('上下文提炼', '注入了已有记忆到系统提示');
          }
        }
      } catch (err) {
        console.warn(`[${requestId}] 上下文提炼失败（不影响主流程）: ${err.message}`);
      }
    }

    // ── 步骤2：上下文压缩 ──
    openaiRequest = compressContextWithReport(openaiRequest, diag);

    // ── 步骤3：Few-Shot 注入 ──
    openaiRequest = injectFewShotWithReport(openaiRequest, diag);

    // ── 步骤3.5：语言指令注入（v5新增） ──
    openaiRequest = injectLanguageInstruction(openaiRequest, diag);

    // ── 步骤4：循环检测（请求阶段） ──
    const loopResult = checkRequestForLoopWithReport(openaiRequest, sessionId, diag);
    if (loopResult.isLoop) {
      excLogger.logLoopDetected(requestId, sessionId,
        loopResult.loopInfo.toolName, loopResult.loopInfo.count);

      // v4: 记录内容哈希重复事件
      if (loopResult.loopInfo.contentHash) {
        excLogger.logContentHashRepeat(requestId, sessionId,
          loopResult.loopInfo.toolName, loopResult.loopInfo.contentHash, loopResult.loopInfo.count);
      }

      // v4: 根据干预级别处理
      if (loopResult.breakAction === 'force_end') {
        // 最高级干预：直接返回终止响应
        const forceResponse = createForceEndResponse(anthropicRequest.model || config.defaultModel);
        const duration = Date.now() - req.startTime;
        diag.stat('总耗时', `${duration}ms`);
        diag.stat('干预', `强制终止 [${loopResult.loopInfo.layer}] (第${loopResult.breakCount}次循环干预, 重复${loopResult.loopInfo.count}次)`);
        diag.print();
        return res.json(forceResponse);
      }

      // 其他级别：使用修改后的请求
      openaiRequest = loopResult.modifiedRequest;
    }

    // ── 步骤4.5：后端请求适配（v7新增） ──
    openaiRequest = backend.prepareRequest(openaiRequest);
    if (config.modelOverride) {
      openaiRequest.model = config.modelOverride;
    }

    // ── 步骤5：转发到后端 ──
    const isStream = openaiRequest.stream || false;
    const forwardMsgCount = openaiRequest.messages.length;
    const forwardToolCount = openaiRequest.tools ? openaiRequest.tools.length : 0;
    console.log(`[${requestId}] → 转发到 ${backend.getName()}: 消息=${forwardMsgCount}, 工具=${forwardToolCount}, 流式=${isStream}`);
    diag.stat('转发消息数', forwardMsgCount);
    diag.stat('转发工具数', forwardToolCount);

    if (isStream) {
      await handleStreamRequest(req, res, openaiRequest, requestId, sessionId, anthropicRequest, diag);
    } else {
      await handleNonStreamRequest(req, res, openaiRequest, requestId, sessionId, anthropicRequest, diag);
    }
  } catch (err) {
    console.error(`[${requestId}] 请求处理失败:`, err.message);
    diag.issue('服务器', `内部错误: ${err.message}`, 'error');
    diag.print();
    excLogger.log('error', 'internal', requestId, sessionId,
      `请求处理失败: ${err.message}`, { stack: err.stack?.substring(0, 500) });
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `适配器内部错误: ${err.message}`,
        },
      });
    }
  }
});

// ═══════════════════════════════════════════════════════
//  POST /v1/chat/completions - OpenAI 兼容端点
// ═══════════════════════════════════════════════════════

app.post('/v1/chat/completions', async (req, res) => {
  const requestId = req.requestId;
  const sessionId = getStableSessionId(req);
  const diag = createReport(requestId);

  const activeReq = activeRequests.get(requestId);
  if (activeReq) activeReq.sessionId = sessionId;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[OpenAI] [${requestId}] 收到请求，会话: ${sessionId}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    let openaiRequest = req.body;

    if (!openaiRequest.messages || !Array.isArray(openaiRequest.messages)) {
      excLogger.logProtocolError(requestId, sessionId, '请求缺少 messages 字段');
      return res.status(400).json({
        error: { message: 'messages 字段必须是非空数组', type: 'invalid_request_error' },
      });
    }

    const origMsgCount = openaiRequest.messages.length;
    const origTools = openaiRequest.tools || [];
    const origStream = openaiRequest.stream ? '流式' : '非流式';
    diag.stat('原始请求', `消息=${origMsgCount}, 工具=${origTools.length}, 模式=${origStream}`);

    analyzeRequestIssues(openaiRequest, diag);

    openaiRequest = compressContextWithReport(openaiRequest, diag);
    openaiRequest = injectFewShotWithReport(openaiRequest, diag);

    // v5: 语言指令注入
    openaiRequest = injectLanguageInstruction(openaiRequest, diag);

    // 循环检测
    const loopResult = checkRequestForLoopWithReport(openaiRequest, sessionId, diag);
    if (loopResult.isLoop) {
      excLogger.logLoopDetected(requestId, sessionId,
        loopResult.loopInfo.toolName, loopResult.loopInfo.count);

      // v4: 记录内容哈希重复事件
      if (loopResult.loopInfo.contentHash) {
        excLogger.logContentHashRepeat(requestId, sessionId,
          loopResult.loopInfo.toolName, loopResult.loopInfo.contentHash, loopResult.loopInfo.count);
      }

      if (loopResult.breakAction === 'force_end') {
        const duration = Date.now() - req.startTime;
        diag.stat('总耗时', `${duration}ms`);
        diag.print();
        return res.status(200).json({
          id: `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: openaiRequest.model || config.defaultModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '[适配器强制终止] 检测到工具调用陷入无法恢复的死循环，已强制结束当前任务。',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      openaiRequest = loopResult.modifiedRequest;
    }

    // v7: 后端适配
    openaiRequest = backend.prepareRequest(openaiRequest);
    if (config.modelOverride) {
      openaiRequest.model = config.modelOverride;
    }

    const isStream = openaiRequest.stream || false;
    console.log(`[${requestId}] → 转发到 ${backend.getName()}: 消息=${openaiRequest.messages.length}, 工具=${openaiRequest.tools?.length || 0}`);

    if (isStream) {
      diag.stat('响应模式', '流式(SSE)');
      await handleOpenAIStreamRequest(req, res, openaiRequest, requestId, sessionId, diag);
    } else {
      const response = await axios.post(backend.getChatCompletionsUrl(), openaiRequest, {
        timeout: config.lmStudioTimeout,
        headers: { 'Content-Type': 'application/json' },
      });

      let data = backend.parseResponse(response.data);
      analyzeRawResponse(data, diag, requestId, sessionId);
      data = repairResponseToolCallsWithReport(data, diag);
      data = fixSimulatedCallsWithReport(data, openaiRequest.tools, diag);

      const loopCheck = checkResponseForLoopWithReport(data, sessionId, diag);
      if (loopCheck.isLoop) {
        if (data.choices?.[0]?.message) {
          data.choices[0].message.content = (data.choices[0].message.content || '') +
            `\n\n[系统警告] ${loopCheck.loopInfo.message}`;
        }
      }

      // v5: 响应语言修正（OpenAI端点）
      if (config.responseLanguageFixEnabled && config.responseLanguage &&
          data.choices?.[0]?.message?.content && !data.choices[0].message.tool_calls?.length) {
        data.choices[0].message.content = fixResponseLanguage(data.choices[0].message.content, diag);
      }

      const duration = Date.now() - req.startTime;
      diag.stat('总耗时', `${duration}ms`);
      diag.print();

      excLogger.logRequestSummary(requestId, sessionId, {
        description: `OpenAI端点请求完成`,
        duration,
        finishReason: data.choices?.[0]?.finish_reason,
        hasToolCalls: !!(data.choices?.[0]?.message?.tool_calls?.length),
      });

      res.json(data);
    }
  } catch (err) {
    console.error(`[${requestId}] OpenAI 请求处理失败:`, err.message);
    diag.issue('服务器', `请求失败: ${err.message}`, 'error');
    diag.print();
    excLogger.log('error', 'internal', requestId, sessionId,
      `OpenAI端点请求失败: ${err.message}`, { stack: err.stack?.substring(0, 500) });
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: `适配器错误: ${err.message}`, type: 'api_error' },
      });
    }
  }
});

// ═══════════════════════════════════════════════════════
//  GET /v1/models
// ═══════════════════════════════════════════════════════

app.get('/v1/models', async (req, res) => {
  try {
    const response = await axios.get(backend.getModelsUrl(), { timeout: 5000 });
    res.json(response.data);
  } catch (err) {
    res.json({
      object: 'list',
      data: [{
        id: config.modelOverride || config.defaultModel,
        object: 'model',
        owned_by: 'local',
      }],
    });
  }
});

// ═══════════════════════════════════════════════════════
//  GET /health
// ═══════════════════════════════════════════════════════

app.get('/health', async (req, res) => {
  let backendStatus = 'unknown';

  try {
    const response = await axios.get(backend.getHealthUrl(), { timeout: 3000 });
    backendStatus = response.status === 200 ? 'connected' : 'error';
  } catch {
    backendStatus = 'disconnected';
  }

  const excStats = excLogger.getStats();

  const health = {
    status: backendStatus === 'connected' ? 'healthy' : 'degraded',
    adapter: {
      port: config.adapterPort,
      version: '8.0.0',
      uptime: process.uptime(),
      activeRequests: activeRequests.size,
      backend: config.backendType,
    },
    backend: {
      type: config.backendType,
      name: backend.getName(),
      status: backendStatus,
      url: backend.getBaseUrl(),
    },
    config: {
      loopDetection: config.loopDetectionEnabled,
      loopDetectionToolOnlyThreshold: config.loopDetectionToolOnlyThreshold,
      loopDetectionContentRepeatThreshold: config.loopDetectionContentRepeatThreshold,
      loopDetectionWindowHashThreshold: config.loopDetectionWindowHashThreshold,
      loopDetectionResponseRepeatThreshold: config.loopDetectionResponseRepeatThreshold,
      fewShot: config.fewShotEnabled,
      jsonRepair: config.jsonRepairEnabled,
      simulatedCallFixer: config.simulatedCallFixerEnabled,
      contextCompression: true,
      diagnosticLogToFile: config.diagnosticLogToFile,
      responseLanguage: config.responseLanguage,
      responseLanguageFix: config.responseLanguageFixEnabled,
      memoryStore: config.memoryStoreEnabled,
      contextRefiner: config.contextRefinerEnabled,
    },
    exceptionStats: excStats,
    memoryStore: memoryStore ? { enabled: true, dir: memoryStoreDir + '/memory/' } : { enabled: false },
  };

  res.status(backendStatus === 'connected' ? 200 : 503).json(health);
});

// ═══════════════════════════════════════════════════════
//  GET /logs
// ═══════════════════════════════════════════════════════

app.get('/logs', (req, res) => {
  const { level, category, sessionId, requestId, limit } = req.query;
  const filter = {};
  if (level) filter.level = level;
  if (category) filter.category = category;
  if (sessionId) filter.sessionId = sessionId;
  if (requestId) filter.requestId = requestId;

  const logs = excLogger.queryLogs(filter, parseInt(limit || '50', 10));
  res.json({ count: logs.length, logs });
});

// ═══════════════════════════════════════════════════════
//  v7: GET /memory — 记忆存储状态查询
// ═══════════════════════════════════════════════════════

app.get('/memory', async (req, res) => {
  if (!memoryStore) {
    return res.json({ enabled: false, sessions: [] });
  }
  try {
    const sessions = await memoryStore.listSessions();
    const result = { enabled: true, dir: memoryStoreDir + '/memory/', sessionCount: sessions.length, sessions };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `记忆存储查询失败: ${err.message}` });
  }
});

// ═══════════════════════════════════════════════════════
//  v7: DELETE /memory/:sessionId — 删除指定会话记忆
// ═══════════════════════════════════════════════════════

app.delete('/memory/:sessionId', async (req, res) => {
  if (!memoryStore) {
    return res.status(400).json({ error: '记忆存储未启用' });
  }
  try {
    await memoryStore.deleteSession(req.params.sessionId);
    res.json({ success: true, sessionId: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ error: `删除记忆失败: ${err.message}` });
  }
});

// ═══════════════════════════════════════════════════════
//  请求/响应分析辅助函数
// ═══════════════════════════════════════════════════════

function analyzeRequestIssues(openaiRequest, diag) {
  const messages = openaiRequest.messages || [];
  const tools = openaiRequest.tools || [];

  const estimatedTokens = estimateTokens(JSON.stringify(openaiRequest));
  if (estimatedTokens > config.contextCompressionThreshold) {
    diag.issue('上下文压缩器', `请求估算 ~${estimatedTokens} tokens，超出压缩阈值 ${config.contextCompressionThreshold}`, 'warn');
  }

  if (tools.length > config.contextMaxTools) {
    diag.issue('上下文压缩器', `工具数 ${tools.length} 超过限制 ${config.contextMaxTools}，将被裁剪`, 'warn');
  }

  let longDescTools = [];
  for (const tool of tools) {
    const func = tool.function || tool;
    const desc = func.description || '';
    if (desc.length > config.contextToolDescriptionMaxLength) {
      longDescTools.push(`${func.name}(${desc.length}字)`);
    }
  }
  if (longDescTools.length > 0) {
    diag.issue('上下文压缩器', `${longDescTools.length}个工具描述过长，将被截断: ${longDescTools.join(', ')}`, 'warn');
  }

  let toolCallHistory = 0;
  for (const msg of messages) {
    if (msg.tool_calls) toolCallHistory++;
    if (msg.role === 'tool') toolCallHistory++;
  }
  if (toolCallHistory > 0) {
    diag.stat('历史工具调用轮次', Math.ceil(toolCallHistory / 2));
  }

  // 检测最近消息中是否有重复的assistant消息
  const recentAssistants = messages.filter(m => m.role === 'assistant').slice(-3);
  if (recentAssistants.length >= 2) {
    const last = recentAssistants[recentAssistants.length - 1];
    const prev = recentAssistants[recentAssistants.length - 2];
    // 比较工具调用名（不比较参数，因为参数可能不同）
    const lastTools = (last.tool_calls || []).map(tc => tc.function?.name).sort().join(',');
    const prevTools = (prev.tool_calls || []).map(tc => tc.function?.name).sort().join(',');
    if (lastTools && lastTools === prevTools && lastTools.length > 0) {
      diag.issue('循环检测器', `最近2条assistant消息调用了相同的工具集: [${lastTools}]，可能陷入循环`, 'error');
    }
  }

  if (!openaiRequest.model) {
    diag.issue('协议转换器', '请求中未指定模型名，将使用默认模型', 'warn');
  }
}

function analyzeRawResponse(data, diag, requestId, sessionId) {
  const choice = data?.choices?.[0];
  if (!choice) {
    diag.issue('服务器', `${backend.getName()} 返回了空响应`, 'error');
    excLogger.logBadResponse(requestId, sessionId, `${backend.getName()} 返回了空响应`, data);
    return;
  }

  const message = choice.message || {};
  const finishReason = choice.finish_reason;

  excLogger.logFinishReason(requestId, sessionId, finishReason, {
    hasToolCalls: !!(message.tool_calls?.length),
    contentLength: message.content?.length || 0,
  });

  if (finishReason === 'length') {
    diag.issue('服务器', `${backend.getName()} 因 max_tokens 限制截断响应 (finish_reason=length)，这可能导致 OpenClaw 任务提前终止！`, 'error');
    diag.fix('服务器', 'finish_reason=length (截断)', '保留原始响应但标记警告',
      `${backend.getName()} 达到 token 上限，建议增大 TOOL_CALL_MAX_TOKENS`);
  }

  if (finishReason === 'content_filter') {
    diag.issue('服务器', `${backend.getName()} 内容过滤触发 (finish_reason=content_filter)`, 'warn');
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolNames = message.tool_calls.map(tc => tc.function?.name).join(', ');
    diag.phase(`${backend.getName()}响应`, `调用了 ${message.tool_calls.length} 个工具: [${toolNames}], finish_reason=${finishReason}`);

    let malformedCount = 0;
    for (const tc of message.tool_calls) {
      if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
        try { JSON.parse(tc.function.arguments); } catch { malformedCount++; }
      }
    }
    if (malformedCount > 0) {
      diag.issue('JSON修复引擎', `${malformedCount}/${message.tool_calls.length} 个工具调用的 arguments 不是合法JSON`, 'error');
    }
  } else if (message.content) {
    diag.phase(`${backend.getName()}响应`, `纯文本回复 (${message.content.length}字), finish_reason=${finishReason}`);

    const content = message.content;
    const simulatedPatterns = [
      /(?:call|use|invoke)\s+\w+\s*\(/gi,
      /Action:\s*\w+/gi,
      /```json\s*\n?\s*\{\s*"name"/gi,
    ];
    let hasSimulated = false;
    for (const pat of simulatedPatterns) {
      pat.lastIndex = 0;
      if (pat.test(content)) { hasSimulated = true; break; }
    }
    if (hasSimulated) {
      diag.issue('模拟调用修复器', '模型用文本描述了工具调用而非使用结构化格式', 'error');
    }

    const controlPatterns = [/<\|tool_calls_section\|>/g, /<\|tool_call\|>/g, /<\|im_start\|>/g, /<\|function_call\|>/g];
    let leakedTokens = [];
    for (const pat of controlPatterns) {
      pat.lastIndex = 0;
      if (pat.test(content)) { leakedTokens.push(pat.source.substring(0, 25)); }
    }
    if (leakedTokens.length > 0) {
      diag.issue('模拟调用修复器', `响应中泄漏了控制token: ${leakedTokens.join(', ')}`, 'warn');
    }
  } else {
    diag.phase(`${backend.getName()}响应`, `空响应, finish_reason=${finishReason}`);
    excLogger.logBadResponse(requestId, sessionId, `${backend.getName()} 返回空消息体 (finish_reason=${finishReason})`, data);
  }

  if (data.usage) {
    diag.stat('输入Token', data.usage.prompt_tokens || 0);
    diag.stat('输出Token', data.usage.completion_tokens || 0);
  }
}

// ═══════════════════════════════════════════════════════
//  BUG修复: convertLMStudioError 函数（之前缺失导致崩溃）
// ═══════════════════════════════════════════════════════

function convertLMStudioError(status, errorData, model) {
  // 将后端的错误响应转换为 Anthropic 格式
  const errorTypeMap = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    500: 'api_error',
    503: 'overloaded_error',
  };

  const errorType = errorTypeMap[status] || 'api_error';
  let errorMessage = `${backend.getName()} 返回了错误`;

  if (errorData) {
    if (typeof errorData === 'object') {
      errorMessage = errorData.error?.message || errorData.message || errorData.error || JSON.stringify(errorData).substring(0, 200);
    } else if (typeof errorData === 'string') {
      errorMessage = errorData.substring(0, 200);
    }
  }

  return {
    id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: `[适配器错误] ${backend.getName()} 返回 ${status}: ${errorMessage}`,
    }],
    model: model || config.defaultModel,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ═══════════════════════════════════════════════════════
//  非流式请求处理（Anthropic 端点）
// ═══════════════════════════════════════════════════════

async function handleNonStreamRequest(req, res, openaiRequest, requestId, sessionId, anthropicRequest, diag) {
  const backendUrl = backend.getChatCompletionsUrl();
  const originalModel = anthropicRequest.model || config.defaultModel;

  try {
    const response = await axios.post(backendUrl, openaiRequest, {
      timeout: config.lmStudioTimeout,
      headers: { 'Content-Type': 'application/json' },
    });

    let data = backend.parseResponse(response.data);

    analyzeRawResponse(data, diag, requestId, sessionId);
    data = repairResponseToolCallsWithReport(data, diag);
    data = fixSimulatedCallsWithReport(data, openaiRequest.tools, diag);

    const loopCheck = checkResponseForLoopWithReport(data, sessionId, diag);
    if (loopCheck.isLoop) {
      if (data.choices?.[0]?.message) {
        data.choices[0].message.content = (data.choices[0].message.content || '') +
          `\n\n[系统警告] ${loopCheck.loopInfo.message}`;
      }
    }

    const hasToolCalls = data.choices?.[0]?.message?.tool_calls?.length > 0;
    const anthropicResponse = convertOpenAIToAnthropic(data, originalModel);

    // v5: 响应语言修正（只修正文本内容块，不修正工具调用）
    if (config.responseLanguageFixEnabled && config.responseLanguage && !hasToolCalls) {
      for (const block of anthropicResponse.content) {
        if (block.type === 'text' && block.text) {
          block.text = fixResponseLanguage(block.text, diag);
        }
      }
    }

    diag.phase('协议转换(响应)', `OpenAI → Anthropic: finish_reason=${data.choices?.[0]?.finish_reason} → stop_reason=${anthropicResponse.stop_reason}${hasToolCalls ? ', tool_calls→tool_use内容块' : ''}`);

    if (anthropicResponse.stop_reason === 'max_tokens') {
      diag.issue('协议转换器', `stop_reason=max_tokens，OpenClaw 可能会因此终止任务`, 'error');
    }

    const duration = Date.now() - req.startTime;
    diag.stat('总耗时', `${duration}ms`);
    diag.print();

    excLogger.logRequestSummary(requestId, sessionId, {
      description: `Anthropic端点请求完成, stop_reason=${anthropicResponse.stop_reason}`,
      duration,
      stopReason: anthropicResponse.stop_reason,
      hasToolUse: anthropicResponse.content?.some(b => b.type === 'tool_use'),
      inputTokens: anthropicResponse.usage?.input_tokens,
      outputTokens: anthropicResponse.usage?.output_tokens,
    });

    res.json(anthropicResponse);
  } catch (err) {
    console.error(`[${requestId}] ${backend.getName()} 请求失败:`, err.message);
    diag.issue('服务器', `${backend.getName()} 请求失败: ${err.message}`, 'error');
    diag.print();

    if (err.code === 'ECONNREFUSED') {
      excLogger.log('error', 'connection', requestId, sessionId,
        `无法连接到 ${backend.getName()}`, { url: backendUrl });
    } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
      excLogger.logTimeout(requestId, sessionId, 'request', config.lmStudioTimeout);
    } else {
      excLogger.log('error', 'upstream', requestId, sessionId,
        `${backend.getName()} 请求失败: ${err.message}`, { code: err.code, status: err.response?.status });
    }

    if (err.response) {
      const status = err.response.status;
      const errorData = err.response.data;
      console.error(`[${requestId}] ${backend.getName()} 错误 ${status}:`, JSON.stringify(errorData).substring(0, 200));

      if (!res.headersSent) {
        const anthropicError = convertLMStudioError(status, errorData, originalModel);
        res.status(status >= 500 ? 502 : status).json(anthropicError);
      }
    } else if (err.code === 'ECONNREFUSED') {
      if (!res.headersSent) {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: `无法连接到 ${backend.getName()}，请确认其正在运行` },
        });
      }
    } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
      if (!res.headersSent) {
        res.status(504).json({
          type: 'error',
          error: { type: 'api_error', message: `${backend.getName()} 请求超时` },
        });
      }
    } else {
      if (!res.headersSent) {
        res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: `适配器错误: ${err.message}` },
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
//  流式请求处理（Anthropic 端点）
// ═══════════════════════════════════════════════════════

async function handleStreamRequest(req, res, openaiRequest, requestId, sessionId, anthropicRequest, diag) {
  const backendUrl = backend.getChatCompletionsUrl();
  const originalModel = anthropicRequest.model || config.defaultModel;

  openaiRequest.stream = true;

  try {
    const response = await axios.post(backendUrl, openaiRequest, {
      timeout: config.lmStudioTimeout,
      headers: { 'Content-Type': 'application/json' },
      responseType: 'stream',
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const streamConverter = new StreamConverter(originalModel);
    let buffer = '';
    let fullContent = '';
    let fullToolCallsData = [];
    let lastFinishReason = null;
    let chunkCount = 0;
    let streamCompleted = false; // v3: 跟踪流是否正常完成

    response.data.on('data', (chunk) => {
      try {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              if (!streamConverter.hasFinished) {
                streamConverter.hasFinished = true;
                res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
              }
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              chunkCount++;

              const choice = parsed.choices?.[0];
              if (choice) {
                if (choice.finish_reason) lastFinishReason = choice.finish_reason;
                if (choice.delta?.content) fullContent += choice.delta.content;
                if (choice.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!fullToolCallsData[idx]) {
                      fullToolCallsData[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                    }
                    if (tc.function?.name && !fullToolCallsData[idx].name) fullToolCallsData[idx].name = tc.function.name;
                    if (tc.function?.arguments) fullToolCallsData[idx].arguments += tc.function.arguments;
                    if (tc.id && !fullToolCallsData[idx].id) fullToolCallsData[idx].id = tc.id;
                  }
                }
              }

              const events = streamConverter.processChunk(parsed);
              for (const event of events) res.write(event);
            } catch (parseErr) {
              if (config.debugLogging) {
                console.log(`[${requestId}] 流式数据解析失败: ${data.substring(0, 100)}`);
              }
            }
          }
        }
        res.flush?.();
      } catch (err) {
        console.error(`[${requestId}] 流式数据处理错误:`, err.message);
      }
    });

    response.data.on('end', () => {
      try {
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const events = streamConverter.processChunk(parsed);
              for (const event of events) res.write(event);
            } catch { /* 忽略 */ }
          }
        }
        if (!streamConverter.hasFinished) {
          streamConverter.hasFinished = true;
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        }

        streamCompleted = true; // v3: 标记流正常完成

        // 后处理分析
        if (lastFinishReason === 'length') {
          excLogger.logFinishReason(requestId, sessionId, 'length', {
            streamMode: true,
            contentLength: fullContent.length,
            toolCallCount: fullToolCallsData.length,
          });
          console.warn(`[${requestId}] ⚠ 流式响应被截断 (finish_reason=length)！OpenClaw 可能因此终止任务`);
          diag.issue('服务器', `流式响应因 max_tokens 被截断 (finish_reason=length)`, 'error');
        }

        for (const tc of fullToolCallsData) {
          if (tc.arguments) {
            try { JSON.parse(tc.arguments); } catch {
              excLogger.logBadResponse(requestId, sessionId,
                `流式响应中工具 ${tc.name} 的 arguments 不是合法JSON`, {
                  toolName: tc.name, argsPreview: tc.arguments.substring(0, 100),
                });
              diag.issue('JSON修复引擎', `流式响应中工具 ${tc.name} 的 arguments 不是合法JSON（已发送，无法修复）`, 'error');
            }
          }
        }

        const duration = Date.now() - req.startTime;
        diag.stat('总耗时', `${duration}ms`);
        diag.stat('流式chunks', chunkCount);
        diag.stat('finish_reason', lastFinishReason || 'stream_end');
        diag.print();

        excLogger.logRequestSummary(requestId, sessionId, {
          description: `Anthropic流式请求完成, finish_reason=${lastFinishReason}`,
          duration, streamMode: true, finishReason: lastFinishReason,
          contentLength: fullContent.length, toolCallCount: fullToolCallsData.length, chunks: chunkCount,
        });

        console.log(`[${requestId}] 流式响应完成 (${chunkCount} chunks, ${duration}ms, finish_reason=${lastFinishReason})`);
        res.end();
      } catch (err) {
        console.error(`[${requestId}] 流式结束处理错误:`, err.message);
        if (!res.writableEnded) res.end();
      }
    });

    response.data.on('error', (err) => {
      console.error(`[${requestId}] ${backend.getName()} 流式错误:`, err.message);
      excLogger.log('error', 'stream', requestId, sessionId,
        `${backend.getName()} 流式错误: ${err.message}`);
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      }
    });

    // v3修复: 只在流未正常完成时才记录客户端断开
    req.on('close', () => {
      if (!streamCompleted) {
        const elapsed = Date.now() - req.startTime;
        excLogger.logClientAbort(requestId, sessionId,
          `流式请求中途断开 (已传输 ${chunkCount} chunks, ${elapsed}ms)`, {
            elapsed, chunksTransferred: chunkCount, lastFinishReason,
          });
        console.warn(`[${requestId}] 流式请求中途断开! 已传输 ${chunkCount} chunks, ${elapsed}ms`);
        try { response.data.destroy(); } catch { /* 忽略 */ }
      }
    });
  } catch (err) {
    console.error(`[${requestId}] 流式请求失败:`, err.message);
    excLogger.log('error', 'stream', requestId, sessionId,
      `流式连接建立失败: ${err.message}`, { code: err.code });
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: `无法建立流式连接到 ${backend.getName()}: ${err.message}` },
      });
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
      } catch { /* 忽略 */ }
      if (!res.writableEnded) res.end();
    }
  }
}

// ═══════════════════════════════════════════════════════
//  流式请求处理（OpenAI 端点）
// ═══════════════════════════════════════════════════════

async function handleOpenAIStreamRequest(req, res, openaiRequest, requestId, sessionId, diag) {
  const streamUrl = backend.getChatCompletionsUrl();
  openaiRequest.stream = true;

  try {
    const response = await axios.post(streamUrl, openaiRequest, {
      timeout: config.lmStudioTimeout,
      headers: { 'Content-Type': 'application/json' },
      responseType: 'stream',
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let buffer = '';
    let lastFinishReason = null;
    let fullContent = '';
    let fullToolCallsData = [];
    let chunkCount = 0;
    let streamCompleted = false; // v3: 跟踪流正常完成

    response.data.on('data', (chunk) => {
      try {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              chunkCount++;
              const choice = parsed.choices?.[0];
              if (choice) {
                if (choice.finish_reason) lastFinishReason = choice.finish_reason;
                if (choice.delta?.content) fullContent += choice.delta.content;
                if (choice.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!fullToolCallsData[idx]) fullToolCallsData[idx] = { id: tc.id || '', name: '', arguments: '' };
                    if (tc.function?.name) fullToolCallsData[idx].name = tc.function.name;
                    if (tc.function?.arguments) fullToolCallsData[idx].arguments += tc.function.arguments;
                    if (tc.id) fullToolCallsData[idx].id = tc.id;
                  }
                }
              }
            } catch { /* 忽略解析失败 */ }

            res.write(`${trimmed}\n\n`);
          } else {
            res.write(`${trimmed}\n\n`);
          }
        }
        res.flush?.();
      } catch (err) {
        console.error(`[${requestId}] OpenAI 流式处理错误:`, err.message);
      }
    });

    response.data.on('end', () => {
      if (buffer.trim()) {
        res.write(`${buffer.trim()}\n\n`);
      }

      streamCompleted = true; // v3

      if (lastFinishReason === 'length') {
        excLogger.logFinishReason(requestId, sessionId, 'length', {
          streamMode: true, endpoint: 'openai',
          contentLength: fullContent.length, toolCallCount: fullToolCallsData.length,
        });
        console.warn(`[${requestId}] ⚠ OpenAI流式响应被截断 (finish_reason=length)！`);
        diag.issue('服务器', `流式响应因 max_tokens 被截断`, 'error');
      }

      for (const tc of fullToolCallsData) {
        if (tc.arguments) {
          try { JSON.parse(tc.arguments); } catch {
            excLogger.logBadResponse(requestId, sessionId,
              `OpenAI流式中工具 ${tc.name} 的 arguments 不是合法JSON`, {
                toolName: tc.name, argsPreview: tc.arguments.substring(0, 100),
              });
          }
        }
      }

      const duration = Date.now() - req.startTime;
      diag.stat('总耗时', `${duration}ms`);
      diag.stat('流式chunks', chunkCount);
      diag.stat('finish_reason', lastFinishReason || 'stream_end');
      diag.print();

      excLogger.logRequestSummary(requestId, sessionId, {
        description: `OpenAI流式请求完成, finish_reason=${lastFinishReason}`,
        duration, streamMode: true, endpoint: 'openai', finishReason: lastFinishReason,
        contentLength: fullContent.length, toolCallCount: fullToolCallsData.length, chunks: chunkCount,
      });

      console.log(`[${requestId}] OpenAI 流式响应完成 (${chunkCount} chunks, ${duration}ms, finish_reason=${lastFinishReason})`);
      res.end();
    });

    response.data.on('error', (err) => {
      console.error(`[${requestId}] OpenAI 流式错误:`, err.message);
      excLogger.log('error', 'stream', requestId, sessionId, `OpenAI流式错误: ${err.message}`);
      if (!res.writableEnded) res.end();
    });

    // v3修复: 只在流未正常完成时才记录
    req.on('close', () => {
      if (!streamCompleted) {
        const elapsed = Date.now() - req.startTime;
        excLogger.logClientAbort(requestId, sessionId,
          `OpenAI流式请求中途断开 (已传输 ${chunkCount} chunks, ${elapsed}ms)`, {
            elapsed, chunksTransferred: chunkCount, lastFinishReason,
          });
        console.warn(`[${requestId}] OpenAI流式请求中途断开!`);
      }
    });
  } catch (err) {
    console.error(`[${requestId}] 流式请求失败:`, err.message);
    excLogger.log('error', 'stream', requestId, sessionId,
      `流式连接建立失败: ${err.message}`, { code: err.code });
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: `无法建立流式连接到 ${backend.getName()}: ${err.message}` },
      });
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
      } catch { /* 忽略 */ }
      if (!res.writableEnded) res.end();
    }
  }
}

// ═══════════════════════════════════════════════════════
//  启动服务
// ═══════════════════════════════════════════════════════

const server = app.listen(config.adapterPort, config.adapterHost, () => {
  console.log(`✓ 适配器已启动: http://${config.adapterHost}:${config.adapterPort}`);
  console.log(`  Anthropic端点: http://localhost:${config.adapterPort}/v1/messages`);
  console.log(`  OpenAI端点:    http://localhost:${config.adapterPort}/v1/chat/completions`);
  console.log(`  健康检查:      http://localhost:${config.adapterPort}/health`);
  console.log(`  异常日志查询:  http://localhost:${config.adapterPort}/logs`);
  console.log('');
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭适配器...');
  server.close(() => {
    console.log('适配器已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});

// 未捕获异常处理
process.on('uncaughtException', (err) => {
  console.error('[致命错误] 未捕获的异常:', err.message);
  console.error(err.stack?.substring(0, 500));
  excLogger.log('error', 'internal', 'fatal', 'fatal',
    `未捕获异常: ${err.message}`, { stack: err.stack?.substring(0, 500) });
});

process.on('unhandledRejection', (reason) => {
  console.error('[致命错误] 未处理的Promise拒绝:', reason);
  excLogger.log('error', 'internal', 'fatal', 'fatal',
    `未处理的Promise拒绝: ${reason}`);
});
