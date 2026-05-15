# Toolchain Adapter v6 - 前端操作说明文档

## 目录

1. [OpenClaw 连接配置](#1-openclaw-连接配置)
2. [健康检查面板](#2-健康检查面板)
3. [日志查询面板](#3-日志查询面板)
4. [循环检测状态监控](#4-循环检测状态监控)
5. [常见操作场景](#5-常见操作场景)

---

## 1. OpenClaw 连接配置

### 1.1 配置 Anthropic API 端点

将 OpenClaw 的 API 请求重定向到适配器：

**Linux/macOS**：

```bash
# 方式1：环境变量
export ANTHROPIC_BASE_URL=http://localhost:3838
export ANTHROPIC_API_KEY=sk-dummy

# 方式2：写入配置文件
echo 'ANTHROPIC_BASE_URL=http://localhost:3838' >> ~/.openclaw.env
echo 'ANTHROPIC_API_KEY=sk-dummy' >> ~/.openclaw.env

# 启动 OpenClaw
openclaw
```

**Windows**：

```powershell
# 方式1：环境变量
$env:ANTHROPIC_BASE_URL = "http://localhost:3838"
$env:ANTHROPIC_API_KEY = "sk-dummy"

# 方式2：系统环境变量（永久）
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:3838", "User")
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-dummy", "User")

# 启动 OpenClaw
openclaw
```

### 1.2 验证连接

启动 OpenClaw 后，在浏览器中访问：

```
http://localhost:3838/health
```

正常响应示例：

```json
{
  "status": "healthy",
  "adapter": {
    "port": 3838,
    "version": "6.0.0",
    "uptime": 123.456,
    "activeRequests": 0
  },
  "lmStudio": {
    "status": "connected",
    "url": "http://localhost:1234"
  },
  "config": {
    "loopDetection": true,
    "loopDetectionContentRepeatThreshold": 10,
    "loopDetectionWindowHashThreshold": 15,
    "loopDetectionResponseRepeatThreshold": 5,
    "responseLanguage": "zh-CN",
    "responseLanguageFix": true
  }
}
```

### 1.3 远程服务器配置

如果适配器部署在远程服务器，需要将 `localhost` 替换为服务器IP：

```bash
export ANTHROPIC_BASE_URL=http://192.168.1.100:3838
```

确保防火墙允许 3838 端口入站。

---

## 2. 健康检查面板

### 2.1 访问健康检查

```
GET http://localhost:3838/health
```

### 2.2 状态字段说明

| 字段 | 说明 |
|------|------|
| `status` | 整体状态：`healthy`（LM Studio已连接）或 `degraded`（LM Studio未连接） |
| `adapter.version` | 适配器版本号 |
| `adapter.uptime` | 运行时间（秒） |
| `adapter.activeRequests` | 当前活跃请求数 |
| `lmStudio.status` | LM Studio连接状态：`connected` / `disconnected` / `unknown` |
| `config.loopDetection` | 循环检测是否开启 |
| `config.responseLanguage` | 响应语言配置 |
| `exceptionStats` | 异常统计（errors / warnings / byCategory） |

### 2.3 健康检查脚本

```bash
#!/bin/bash
# health-check.sh
RESPONSE=$(curl -s http://localhost:3838/health)
STATUS=$(echo $RESPONSE | jq -r '.status')
LM_STATUS=$(echo $RESPONSE | jq -r '.lmStudio.status')

echo "适配器状态: $STATUS"
echo "LM Studio: $LM_STATUS"

if [ "$STATUS" != "healthy" ]; then
  echo "⚠ 适配器不健康！"
  exit 1
fi
echo "✓ 适配器运行正常"
```

---

## 3. 日志查询面板

### 3.1 访问日志查询

```
GET http://localhost:3838/logs
```

### 3.2 查询参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `level` | 日志级别过滤 | `error`, `warn`, `info` |
| `category` | 类别过滤 | `loop`, `abort`, `response` |
| `sessionId` | 会话ID过滤 | `sess_abc123` |
| `requestId` | 请求ID过滤 | `a1b2c3d4` |
| `limit` | 返回条数 | `50`（默认），最大200 |

### 3.3 查询示例

```bash
# 查询所有错误日志
curl "http://localhost:3838/logs?level=error&limit=20"

# 查询循环检测事件
curl "http://localhost:3838/logs?category=loop&limit=10"

# 查询特定会话的日志
curl "http://localhost:3838/logs?sessionId=sess_abc123"

# 查询响应内容重复事件（v6新增）
curl "http://localhost:3838/logs?category=response_hash_repeat"

# 查询窗口哈希频率事件（v6新增）
curl "http://localhost:3838/logs?category=window_hash_repeat"
```

### 3.4 日志类别说明

| 类别 | 说明 |
|------|------|
| `loop` | 循环检测触发 |
| `abort` | 客户端断开 |
| `finish_reason` | finish_reason异常（如length截断） |
| `connection` | 连接错误 |
| `summary` | 请求摘要 |
| `content_hash_repeat` | 请求内容哈希重复 |
| `response_hash_repeat` | **v6新增** 响应内容哈希重复 |
| `window_hash_repeat` | **v6新增** 窗口哈希频率触发 |
| `response` | 响应异常 |
| `protocol` | 协议异常 |
| `language` | 语言修正 |

---

## 4. 循环检测状态监控

### 4.1 检测层级

适配器v6的循环检测包含7个层级，按优先级从高到低：

| 层级 | 检测方式 | v6 | 配置阈值 |
|------|---------|-----|---------|
| 第0层 | 请求内容哈希连续重复 | v5 | `CONTENT_REPEAT_THRESHOLD=10` |
| 第0.5层 | 请求内容哈希窗口频率 | **v6新增** | `WINDOW_HASH_THRESHOLD=15` |
| 第1层 | 精确匹配 | v3 | `THRESHOLD=3` |
| 第2层 | 工具名频率 | v3 | `TOOL_ONLY_THRESHOLD=5` |
| 第3层 | 语义相似度 | v3 | 自动（THRESHOLD+1） |
| 第4层 | 全局频率 | v3 | 自动（2分钟内10次） |
| R0层 | 响应内容重复 | **v6新增** | `RESPONSE_REPEAT_THRESHOLD=5` |

### 4.2 干预级别

当检测到循环时，适配器会根据严重程度采取不同的干预措施：

1. **inject_message**：在请求中注入中断消息，警告模型停止循环
2. **strip_tools**：剥离所有工具定义，强制模型使用纯文本回复
3. **force_end**：直接返回终止响应，结束当前任务

干预级别随检测次数递增：第1次检测 → inject_message，第2次 → strip_tools，第3次+ → force_end。

### 4.3 监控脚本

```bash
#!/bin/bash
# loop-monitor.sh - 监控循环检测事件
while true; do
  LOOP_COUNT=$(curl -s "http://localhost:3838/logs?category=loop&limit=1" | jq '.count // 0')
  HASH_REPEAT=$(curl -s "http://localhost:3838/logs?category=content_hash_repeat&limit=1" | jq '.count // 0')
  RESP_REPEAT=$(curl -s "http://localhost:3838/logs?category=response_hash_repeat&limit=1" | jq '.count // 0')
  
  echo "[$(date +%H:%M:%S)] 循环检测: $LOOP_COUNT, 内容重复: $HASH_REPEAT, 响应重复: $RESP_REPEAT"
  sleep 30
done
```

---

## 5. 常见操作场景

### 5.1 调整循环检测灵敏度

如果正常操作频繁被误判为循环：

```env
# 放宽阈值
LOOP_DETECTION_CONTENT_REPEAT_THRESHOLD=20
LOOP_DETECTION_WINDOW_HASH_THRESHOLD=25
LOOP_DETECTION_RESPONSE_REPEAT_THRESHOLD=8
```

如果死循环检测不到：

```env
# 收紧阈值
LOOP_DETECTION_CONTENT_REPEAT_THRESHOLD=5
LOOP_DETECTION_WINDOW_HASH_THRESHOLD=8
LOOP_DETECTION_RESPONSE_REPEAT_THRESHOLD=3
```

### 5.2 关闭特定检测

```env
# 只关闭响应内容重复检测（设为很大值）
LOOP_DETECTION_RESPONSE_REPEAT_THRESHOLD=999

# 完全关闭循环检测（不推荐）
LOOP_DETECTION_ENABLED=false
```

### 5.3 切换响应语言

```env
# 日文
RESPONSE_LANGUAGE=ja

# 英文
RESPONSE_LANGUAGE=en

# 不修正语言
RESPONSE_LANGUAGE=
```

### 5.4 开启调试模式

```env
DEBUG_LOGGING=true
```

调试模式会输出更详细的处理过程，包括每条流式数据的解析结果。

### 5.5 查看模型列表

```bash
curl http://localhost:3838/v1/models
```

### 5.6 测试适配器功能

```bash
# 发送简单的文本请求
curl -X POST http://localhost:3838/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-model",
    "max_tokens": 256,
    "messages": [
      {"role": "user", "content": "你好，请用中文回答"}
    ]
  }'
```
