# Toolchain Adapter v8 - Windows 部署说明文档

## 目录

1. [环境准备](#1-环境准备)
2. [安装步骤](#2-安装步骤)
3. [配置为 Windows 服务](#3-配置为-windows-服务)
4. [使用 PM2 管理](#4-使用-pm2-管理)
5. [客户端配置](#5-客户端配置)
6. [llama.cpp 后端配置](#6-llamacpp-后端配置)
7. [配置文件详解](#7-配置文件详解)
8. [常见问题排查](#8-常见问题排查)

---

## 1. 环境准备

### 1.1 系统要求

| 组件 | 最低要求 | 推荐配置 |
|------|----------|----------|
| 操作系统 | Windows 10 64位 | Windows 11 64位 |
| Node.js | 18.0.0 | 20.x LTS |
| PowerShell | 5.1 | 7.x |
| 内存 | 4GB（不含模型） | 16GB+ |
| 磁盘 | 500MB | 2GB+（含日志和记忆存储） |
| 网络 | 后端服务可达 | 本地回环 |

### 1.2 安装 Node.js

1. 访问 https://nodejs.org/
2. 下载 LTS 版本（推荐 20.x）
3. 运行安装程序，勾选 "Add to PATH"
4. 验证安装：

```powershell
node -v
npm -v
```

### 1.3 安装 LM Studio

1. 访问 https://lmstudio.ai/
2. 下载并安装 LM Studio
3. 启动 LM Studio，加载一个支持工具调用的模型
4. 确认 LM Studio 的本地服务器端口（默认 1234）

### 1.4 安装 llama.cpp（可选）

1. 访问 https://github.com/ggml-org/llama.cpp/releases
2. 下载 Windows 版本（`llama-xxxxx-bin-win-xxx.zip`）
3. 解压到任意目录，如 `C:\llama.cpp\`
4. 确认 `llama-server.exe` 可运行：

```powershell
C:\llama.cpp\llama-server.exe --help
```

---

## 2. 安装步骤

### 2.1 一键安装（推荐）

```powershell
# 解压安装包到目标目录（如 D:\toolchain-adapter）
Expand-Archive -Path toolchain-adapter-v8.zip -DestinationPath D:\toolchain-adapter
cd D:\toolchain-adapter

# 运行安装脚本
.\install.ps1
```

安装脚本会自动完成：检查 Node.js → 安装依赖 → 配置 .env → 创建工作目录。

### 2.2 手动安装

```powershell
# 1. 解压并进入目录
cd D:\toolchain-adapter

# 2. 安装依赖
npm install --production

# 3. 配置环境变量
Copy-Item .env.example .env
notepad .env

# 4. 启动适配器
.\start.ps1
```

### 2.3 验证安装

```powershell
# 另开 PowerShell 窗口，检查健康状态
Invoke-RestMethod -Uri http://localhost:3838/health
```

正常返回应包含：
```json
{
  "status": "healthy",
  "adapter": { "version": "8.0.0", "backend": "lmstudio" },
  "backend": { "status": "connected" }
}
```

---

## 3. 配置为 Windows 服务

### 3.1 使用 nssm（推荐）

[nssm](https://nssm.cc/) 是将 Node.js 应用注册为 Windows 服务的最佳工具。

```powershell
# 1. 下载 nssm
# 从 https://nssm.cc/download 下载并解压

# 2. 安装服务（管理员权限运行）
nssm install ToolchainAdapter "C:\Program Files\nodejs\node.exe" "D:\toolchain-adapter\server.js"

# 3. 配置服务参数
nssm set ToolchainAdapter AppDirectory "D:\toolchain-adapter"
nssm set ToolchainAdapter DisplayName "Toolchain Adapter v8"
nssm set ToolchainAdapter Description "OpenClaw/LM Studio/llama.cpp Protocol Adapter"
nssm set ToolchainAdapter Start SERVICE_AUTO_START
nssm set ToolchainAdapter AppStdout "D:\toolchain-adapter\logs\service-stdout.log"
nssm set ToolchainAdapter AppStderr "D:\toolchain-adapter\logs\service-stderr.log"
nssm set ToolchainAdapter AppRotateFiles 1
nssm set ToolchainAdapter AppRotateBytes 10485760

# 4. 配置环境变量（通过 nssm 设置）
nssm set ToolchainAdapter AppEnvironmentExtra BACKEND_TYPE=lmstudio LM_STUDIO_BASE_URL=http://localhost:1234

# 5. 启动服务
nssm start ToolchainAdapter

# 6. 查看状态
nssm status ToolchainAdapter
```

### 3.2 服务管理命令

```powershell
# 启动
nssm start ToolchainAdapter

# 停止
nssm stop ToolchainAdapter

# 重启
nssm restart ToolchainAdapter

# 查看状态
nssm status ToolchainAdapter

# 删除服务
nssm remove ToolchainAdapter confirm
```

---

## 4. 使用 PM2 管理

PM2 是 Node.js 进程管理器，支持自动重启、日志管理、开机自启。

```powershell
# 1. 全局安装 PM2
npm install -g pm2 pm2-windows-startup

# 2. 配置开机自启
pm2-startup install

# 3. 启动适配器
pm2 start server.js --name toolchain-adapter

# 4. 保存进程列表（用于开机恢复）
pm2 save

# 5. 常用命令
pm2 status                        # 查看所有进程
pm2 logs toolchain-adapter        # 查看日志
pm2 restart toolchain-adapter     # 重启
pm2 stop toolchain-adapter        # 停止
pm2 delete toolchain-adapter      # 删除
pm2 monit                         # 实时监控
```

### 4.1 PM2 生态系统配置

创建 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [{
    name: 'toolchain-adapter',
    script: 'server.js',
    cwd: 'D:\\toolchain-adapter',
    env: {
      NODE_ENV: 'production',
      BACKEND_TYPE: 'lmstudio',
      LM_STUDIO_BASE_URL: 'http://localhost:1234',
      ADAPTER_PORT: '3838',
    },
    // 日志配置
    output: './logs/pm2-stdout.log',
    error: './logs/pm2-stderr.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // 自动重启配置
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
  }]
};
```

使用配置文件启动：

```powershell
pm2 start ecosystem.config.js
```

---

## 5. 客户端配置

### 5.1 OpenClaw (Claude Code) 配置

在 PowerShell 中设置环境变量：

```powershell
# 临时设置（当前会话）
$env:ANTHROPIC_BASE_URL = "http://localhost:3838"
$env:ANTHROPIC_API_KEY = "sk-dummy"

# 启动 OpenClaw
openclaw
```

永久设置（系统级）：

```powershell
# 通过注册表设置系统环境变量（管理员权限）
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:3838", "User")
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-dummy", "User")
```

### 5.2 防火墙配置

如果 OpenClaw 运行在另一台机器上，需要开放适配器端口：

```powershell
# 管理员权限运行
New-NetFirewallRule -DisplayName "Toolchain Adapter" -Direction Inbound -LocalPort 3838 -Protocol TCP -Action Allow
```

---

## 6. llama.cpp 后端配置

### 6.1 启动 llama-server

使用辅助脚本启动：

```powershell
# CPU 模式
.\start-llamacpp.ps1 -ModelPath D:\models\qwen2.5-7b-instruct-q4_k_m.gguf -Port 8080

# GPU 模式（需要 CUDA 支持）
.\start-llamacpp.ps1 -ModelPath D:\models\qwen2.5-7b-instruct-q4_k_m.gguf -Port 8080 -GPULayers 32

# 自定义上下文大小
.\start-llamacpp.ps1 -ModelPath D:\models\model.gguf -ContextSize 32768 -Port 8080
```

或手动启动：

```powershell
C:\llama.cpp\llama-server.exe -m D:\models\model.gguf -c 8192 --port 8080 --host 0.0.0.0
```

### 6.2 切换适配器到 llama.cpp 后端

```powershell
# 方式1：设置环境变量
$env:BACKEND_TYPE = "llamacpp"
$env:LLAMACPP_BASE_URL = "http://localhost:8080"
.\start.ps1

# 方式2：编辑 .env 文件
notepad .env
# 修改 BACKEND_TYPE=llamacpp
# 修改 LLAMACPP_BASE_URL=http://localhost:8080
```

### 6.3 同时运行 LM Studio 和 llama.cpp

可以同时运行两个后端，通过 BACKEND_TYPE 切换：

```powershell
# 使用 LM Studio
$env:BACKEND_TYPE = "lmstudio"; npm start

# 使用 llama.cpp
$env:BACKEND_TYPE = "llamacpp"; npm start
```

---

## 7. 配置文件详解

### 7.1 多后端配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BACKEND_TYPE` | `lmstudio` | 后端类型：`lmstudio` 或 `llamacpp` |
| `LM_STUDIO_BASE_URL` | `http://localhost:1234` | LM Studio 服务地址 |
| `LLAMACPP_BASE_URL` | `http://localhost:8080` | llama.cpp 服务地址 |
| `LLAMACPP_CACHE_PROMPT` | `true` | llama.cpp 是否启用 prompt 缓存 |
| `LLAMACPP_REASONING_FORMAT` | 空 | llama.cpp reasoning 格式 |

### 7.2 记忆存储配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_STORE_ENABLED` | `true` | 是否启用 SSD 永久记忆 |
| `MEMORY_STORE_DIR` | 空 | 记忆目录（留空用项目目录） |
| `CONTEXT_REFINER_ENABLED` | `true` | 是否启用上下文提炼 |
| `CONTEXT_REFINER_THRESHOLD_RATIO` | `0.8` | 提炼触发阈值（80%） |
| `MEMORY_CLEANUP_MAX_AGE` | `604800000` | 记忆最大保留（7天） |

### 7.3 日志文件位置

日志文件保存在项目目录下的 `logs\` 文件夹：

- `logs\adapter-YYYY-MM-DD.log` — 异常日志
- `logs\diagnostic-YYYY-MM-DD.log` — 诊断日志

记忆文件保存在 `memory\` 文件夹：

- `memory\{sessionId}.json` — 每个会话一个文件

---

## 8. 常见问题排查

### Q1: PowerShell 执行策略限制

```powershell
# 查看当前策略
Get-ExecutionPolicy

# 临时允许运行脚本
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# 永久允许（管理员权限）
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Q2: 端口被占用

```powershell
# 查找占用 3838 端口的进程
netstat -ano | findstr :3838

# 强制终止进程（替换 PID）
taskkill /PID <进程ID> /F
```

### Q3: 服务启动后无法连接后端

```powershell
# 检查 LM Studio 连接
Invoke-RestMethod -Uri http://localhost:1234/v1/models

# 检查 llama.cpp 连接
Invoke-RestMethod -Uri http://localhost:8080/health

# 检查适配器状态
Invoke-RestMethod -Uri http://localhost:3838/health
```

### Q4: 中文提问仍然返回英文

确保 `.env` 中以下配置：

```env
RESPONSE_LANGUAGE=zh-CN
RESPONSE_LANGUAGE_FIX_ENABLED=true
```

如果仍然无效，使用更强的自定义指令：

```env
RESPONSE_LANGUAGE_INSTRUCTION=你必须使用中文回答。你的所有回复都必须是中文。不要使用英文。
```

### Q5: 记忆存储文件路径问题

Windows 上如果路径包含中文或空格，确保使用引号包裹：

```env
MEMORY_STORE_DIR=D:\My Projects\toolchain-adapter
```

Node.js 的 `path.join()` 会自动处理 Windows 路径分隔符。

### Q6: nssm 服务启动失败

1. 确认 Node.js 路径正确：`where node`
2. 确认工作目录正确
3. 检查日志文件：`D:\toolchain-adapter\logs\service-stderr.log`
4. 尝试手动运行：`node server.js`

### Q7: 循环检测误报

```env
LOOP_DETECTION_ENABLED=false
# 或调大阈值
LOOP_DETECTION_CONTENT_REPEAT_THRESHOLD=30
LOOP_DETECTION_WINDOW_HASH_THRESHOLD=25
```
