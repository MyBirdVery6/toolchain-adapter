/**
 * 配置模块 v7 - 管理适配器的所有可配置参数
 *
 * v7 增强：
 * - 新增多后端支持（LM Studio / llama.cpp）
 * - 新增 SSD 永久记忆存储配置
 * - 新增上下文提炼配置
 * - 保留所有 v6 配置项的兼容性
 *
 * v6 增强：
 * - 新增响应内容重复检测阈值（LOOP_DETECTION_RESPONSE_REPEAT_THRESHOLD）
 * - 新增窗口内哈希重复阈值（LOOP_DETECTION_WINDOW_HASH_THRESHOLD）
 * - 新增窗口回看时间配置（LOOP_DETECTION_WINDOW_LOOKBACK_SECONDS）
 * - 完善循环检测的多层配置体系
 * - 保留所有 v5 配置项的兼容性
 */

require('dotenv').config();

const config = {
  // ─── LM Studio 连接配置 ───
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234',
  lmStudioTimeout: parseInt(process.env.LM_STUDIO_TIMEOUT || '120000', 10),

  // ─── 适配器服务配置 ───
  adapterPort: parseInt(process.env.ADAPTER_PORT || '3838', 10),
  adapterHost: process.env.ADAPTER_HOST || '0.0.0.0',

  // ─── 模型配置 ───
  modelOverride: process.env.MODEL_OVERRIDE || '',
  defaultModel: process.env.DEFAULT_MODEL || 'local-model',

  // ─── 工具调用参数 ───
  toolCallTemperature: parseFloat(process.env.TOOL_CALL_TEMPERATURE || '0.1'),
  toolCallMaxTokens: parseInt(process.env.TOOL_CALL_MAX_TOKENS || '4096', 10),

  // ─── 上下文压缩配置 ───
  contextCompressionThreshold: parseInt(process.env.CONTEXT_COMPRESSION_THRESHOLD || '8000', 10),
  contextMaxTools: parseInt(process.env.CONTEXT_MAX_TOOLS || '20', 10),
  contextToolDescriptionMaxLength: parseInt(process.env.CONTEXT_TOOL_DESC_MAX_LENGTH || '200', 10),

  // ─── 循环检测配置 ───
  loopDetectionEnabled: process.env.LOOP_DETECTION_ENABLED !== 'false',
  loopDetectionWindowSize: parseInt(process.env.LOOP_DETECTION_WINDOW_SIZE || '20', 10),
  loopDetectionThreshold: parseInt(process.env.LOOP_DETECTION_THRESHOLD || '3', 10),
  // 仅工具名匹配的阈值（同一工具不管参数）
  loopDetectionToolOnlyThreshold: parseInt(process.env.LOOP_DETECTION_TOOL_ONLY_THRESHOLD || '5', 10),
  // 请求内容哈希连续重复阈值（同一哈希从末尾连续重复N次）
  loopDetectionContentRepeatThreshold: parseInt(
    process.env.LOOP_DETECTION_CONTENT_REPEAT_THRESHOLD || '10', 10
  ),
  // v6新增: 窗口内哈希重复阈值（同一哈希在时间窗口内出现N次，不管是否连续）
  // 解决 OpenClaw 交替式死循环：A,B,A,B... 永远不会"连续"10次相同
  // 但在窗口内 A 出现了20次，应该触发检测
  loopDetectionWindowHashThreshold: parseInt(
    process.env.LOOP_DETECTION_WINDOW_HASH_THRESHOLD || '15', 10
  ),
  // v6新增: 窗口回看时间（秒），默认300秒（5分钟）
  loopDetectionWindowLookbackSeconds: parseInt(
    process.env.LOOP_DETECTION_WINDOW_LOOKBACK_SECONDS || '300', 10
  ),
  // v6新增: 响应内容重复检测阈值（同一响应内容哈希连续重复N次）
  // 当模型反复生成相同的响应内容（不是工具调用），说明模型卡住了
  loopDetectionResponseRepeatThreshold: parseInt(
    process.env.LOOP_DETECTION_RESPONSE_REPEAT_THRESHOLD || '5', 10
  ),

  // ─── 模拟调用修复配置 ───
  simulatedCallFixerEnabled: process.env.SIMULATED_CALL_FIXER_ENABLED !== 'false',

  // ─── Few-Shot 注入配置 ───
  fewShotEnabled: process.env.FEW_SHOT_ENABLED !== 'false',
  fewShotMaxExamples: parseInt(process.env.FEW_SHOT_MAX_EXAMPLES || '2', 10),

  // ─── JSON 修复配置 ───
  jsonRepairEnabled: process.env.JSON_REPAIR_ENABLED !== 'false',

  // ─── 响应语言配置 ───
  // 响应语言：设置模型回复使用的语言（如 'zh-CN', 'en', 'ja' 等）
  // 设为空字符串则不注入语言指令
  responseLanguage: process.env.RESPONSE_LANGUAGE || 'zh-CN',
  // 自定义语言指令（如果设置，将覆盖默认的语言指令文本）
  responseLanguageInstruction: process.env.RESPONSE_LANGUAGE_INSTRUCTION || '',
  // 是否对响应内容进行语言修正（检测到非目标语言时追加提示）
  responseLanguageFixEnabled: process.env.RESPONSE_LANGUAGE_FIX_ENABLED !== 'false',

  // ─── 日志配置 ───
  debugLogging: process.env.DEBUG_LOGGING === 'true',
  // 诊断日志默认始终开启
  diagnosticLogging: process.env.DIAGNOSTIC_LOGGING !== 'false',
  // 诊断日志持久化到文件（默认开启）
  diagnosticLogToFile: process.env.DIAGNOSTIC_LOG_TO_FILE !== 'false',
  // 异常日志持久化到文件（默认开启）
  exceptionLogToFile: process.env.EXCEPTION_LOG_TO_FILE !== 'false',
  logLevel: process.env.LOG_LEVEL || 'info',

  // ─── 流式响应配置 ───
  streamBufferMs: parseInt(process.env.STREAM_BUFFER_MS || '50', 10),

  // ─── 安全配置 ───
  maxRequestSize: process.env.MAX_REQUEST_SIZE || '10mb',

  // ─── v7: 多后端配置 ───
  // 后端类型: 'lmstudio' 或 'llamacpp'
  backendType: process.env.BACKEND_TYPE || 'lmstudio',
  // llama.cpp 服务器 URL（仅 llamacpp 后端使用）
  llamacppBaseUrl: process.env.LLAMACPP_BASE_URL || 'http://localhost:8080',
  // llama.cpp 特定参数
  llamacppCachePrompt: process.env.LLAMACPP_CACHE_PROMPT !== 'false',
  llamacppReasoningFormat: process.env.LLAMACPP_REASONING_FORMAT || '',

  // ─── v7: 记忆存储配置 ───
  // 是否启用 SSD 永久记忆存储（防止项目失忆）
  memoryStoreEnabled: process.env.MEMORY_STORE_ENABLED !== 'false',
  // 记忆存储目录（相对于项目根目录）
  memoryStoreDir: process.env.MEMORY_STORE_DIR || '',

  // ─── v7: 上下文提炼配置 ───
  // 是否启用上下文提炼（在压缩前提取关键事实保存到记忆）
  contextRefinerEnabled: process.env.CONTEXT_REFINER_ENABLED !== 'false',
  // 提炼触发阈值比例（占 contextCompressionThreshold 的百分比）
  contextRefinerThresholdRatio: parseFloat(process.env.CONTEXT_REFINER_THRESHOLD_RATIO || '0.8'),
  // 记忆清理最大年龄（毫秒），默认7天
  memoryCleanupMaxAge: parseInt(process.env.MEMORY_CLEANUP_MAX_AGE || String(7 * 24 * 60 * 60 * 1000), 10),
};

module.exports = config;
