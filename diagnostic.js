/**
 * 诊断日志模块 v4 - 提供适配器工作过程的详细可视化日志 + 文件持久化
 *
 * v4 增强：
 * - 诊断报告同时输出到控制台和日志文件
 * - 修复之前诊断报告只输出到console不写入文件的bug
 * - 新增纯文本降级模式（Windows终端兼容）
 * - 报告内容同时写入异常日志系统，可通过 /logs API 查询
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// ─── 诊断开关 ───
let DIAGNOSTIC_ENABLED = true;
if (process.env.DIAGNOSTIC_LOGGING === 'false') {
  DIAGNOSTIC_ENABLED = false;
}

// ─── 颜色代码 ───
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow:'\x1b[43m',
  bgBlue:  '\x1b[44m',
};

// ─── 诊断日志文件路径 ───
const LOG_DIR = path.join(__dirname, 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch { /* 忽略权限问题 */ }
  }
}

function getDiagnosticLogPath() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  return path.join(LOG_DIR, `diagnostic-${dateStr}.log`);
}

/**
 * 将诊断报告写入文件（纯文本格式，无颜色代码）
 */
function writeDiagnosticToFile(plainText) {
  if (!config.diagnosticLogToFile) return;

  try {
    ensureLogDir();
    const logPath = getDiagnosticLogPath();
    const line = `[${new Date().toISOString()}] ${plainText}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch (err) {
    // 静默失败，不影响主流程
  }
}

// 启动时输出状态
if (DIAGNOSTIC_ENABLED) {
  console.log('[诊断日志] 已启用 - 将输出详细的适配器处理报告（控制台+文件）');
} else {
  console.log('[诊断日志] 已禁用 - 设置 DIAGNOSTIC_LOGGING=true 可开启');
}

/**
 * 剥除ANSI颜色代码
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 为一个请求创建诊断报告收集器
 */
function createReport(requestId) {
  const report = {
    requestId,
    timestamp: new Date().toISOString(),
    phases: [],       // 各阶段的工作记录
    issues: [],       // 发现的问题
    fixes: [],        // 执行的修复
    stats: {},        // 统计数据
  };

  return {
    /** 记录一个处理阶段 */
    phase(name, detail) {
      report.phases.push({ name, detail, time: Date.now() });
      // 关键阶段实时输出到控制台和文件
      const detailStr = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
      console.log(`[诊断] [${requestId}] ${name}: ${detailStr}`);
      writeDiagnosticToFile(`[${requestId}] ${name}: ${detailStr}`);
    },

    /** 记录发现的问题 */
    issue(module, description, severity = 'warn') {
      report.issues.push({ module, description, severity });
      // 问题实时输出
      const icon = severity === 'error' ? '✗' : '⚠';
      const line = `[诊断] [${requestId}] ${icon} [${module}] ${description}`;
      if (severity === 'error') {
        console.error(line);
      } else {
        console.warn(line);
      }
      writeDiagnosticToFile(`[${requestId}] ${icon} [${module}] ${description}`);
    },

    /** 记录执行的修复 */
    fix(module, before, after, description) {
      report.fixes.push({ module, before, after, description });
      const line = `[诊断] [${requestId}] 修复 [${module}] ${description}`;
      console.log(line);
      writeDiagnosticToFile(`[${requestId}] 修复 [${module}] ${description}`);
    },

    /** 记录统计 */
    stat(key, value) {
      report.stats[key] = value;
    },

    /** 获取原始报告对象 */
    getReport() {
      return report;
    },

    /** 输出诊断报告到控制台 + 文件 */
    print() {
      const rid = report.requestId;
      const lines = [];

      // ── 请求头 ──
      lines.push('');
      lines.push(`${C.bgBlue}${C.white}${C.bold} ┌─ 适配器诊断报告 [${rid}] ─${C.reset}`);
      lines.push(`${C.bgBlue}${C.white} │${C.reset} ${C.dim}${new Date().toLocaleTimeString()}${C.reset}`);

      // ── 处理流水线 ──
      if (report.phases.length > 0) {
        lines.push(`${C.bgBlue}${C.white} │${C.reset}`);
        lines.push(`${C.bgBlue}${C.white} │${C.reset} ${C.bold}${C.cyan}▸ 处理流水线${C.reset}`);
        for (const p of report.phases) {
          const detail = typeof p.detail === 'object' ? JSON.stringify(p.detail) : p.detail;
          const detailStr = detail ? ` ${C.dim}→ ${detail}${C.reset}` : '';
          lines.push(`${C.bgBlue}${C.white} │${C.reset}   ${C.green}✓${C.reset} ${p.name}${detailStr}`);
        }
      }

      // ── 发现的问题 ──
      if (report.issues.length > 0) {
        lines.push(`${C.bgBlue}${C.white} │${C.reset}`);
        lines.push(`${C.bgBlue}${C.white} │${C.reset} ${C.bold}${C.yellow}⚠ 发现的问题 (${report.issues.length})${C.reset}`);
        for (const iss of report.issues) {
          const icon = iss.severity === 'error' ? `${C.red}✗${C.reset}` : `${C.yellow}⚠${C.reset}`;
          lines.push(`${C.bgBlue}${C.white} │${C.reset}   ${icon} [${C.magenta}${iss.module}${C.reset}] ${iss.description}`);
        }
      } else {
        lines.push(`${C.bgBlue}${C.white} │${C.reset}`);
        lines.push(`${C.bgBlue}${C.white} │${C.reset}   ${C.green}✓ 未发现问题${C.reset}`);
      }

      // ── 执行的修复 ──
      if (report.fixes.length > 0) {
        lines.push(`${C.bgBlue}${C.white} │${C.reset}`);
        lines.push(`${C.bgBlue}${C.white} │${C.reset} ${C.bold}${C.green}🔧 执行的修复 (${report.fixes.length})${C.reset}`);
        for (const f of report.fixes) {
          lines.push(`${C.bgBlue}${C.white} │${C.reset}   ${C.green}→${C.reset} [${C.magenta}${f.module}${C.reset}] ${f.description}`);
          if (f.before && f.after) {
            const beforeStr = typeof f.before === 'string' ? f.before.substring(0, 80) : JSON.stringify(f.before).substring(0, 80);
            const afterStr = typeof f.after === 'string' ? f.after.substring(0, 80) : JSON.stringify(f.after).substring(0, 80);
            lines.push(`${C.bgBlue}${C.white} │${C.reset}     ${C.dim}修复前: ${beforeStr}${C.reset}`);
            lines.push(`${C.bgBlue}${C.white} │${C.reset}     ${C.dim}修复后: ${afterStr}${C.reset}`);
          }
        }
      }

      // ── 统计 ──
      if (Object.keys(report.stats).length > 0) {
        lines.push(`${C.bgBlue}${C.white} │${C.reset}`);
        lines.push(`${C.bgBlue}${C.white} │${C.reset} ${C.bold}${C.cyan}📊 统计${C.reset}`);
        for (const [key, value] of Object.entries(report.stats)) {
          lines.push(`${C.bgBlue}${C.white} │${C.reset}   ${key}: ${C.bold}${value}${C.reset}`);
        }
      }

      lines.push(`${C.bgBlue}${C.white} └${'─'.repeat(40)}${C.reset}`);
      lines.push('');

      // 输出到控制台
      console.log(lines.join('\n'));

      // 同时输出到文件（剥除颜色代码）
      const plainLines = lines.map(l => stripAnsi(l));
      writeDiagnosticToFile(plainLines.join('\n'));
    },
  };
}

module.exports = { createReport, DIAGNOSTIC_ENABLED, writeDiagnosticToFile };
