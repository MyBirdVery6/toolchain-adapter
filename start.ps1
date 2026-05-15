# ==============================================================================
# Toolchain Adapter v8 - PowerShell 启动脚本 (Windows 专用)
# 支持 LM Studio 和 llama.cpp 两种后端
# ==============================================================================

$ErrorActionPreference = "Stop"

# 切换到脚本所在目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ─── 加载 .env 文件到 PowerShell 环境 ───
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        $line = $_.Trim()
        # 跳过空行和注释行
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split '=', 2
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim()
                # 仅设置尚未定义的环境变量（优先使用系统级变量）
                if (-not [System.Environment]::GetEnvironmentVariable($key)) {
                    [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
                }
            }
        }
    }
}

# ─── 颜色输出辅助函数 ───
function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

function Write-Banner {
    Write-Host ""
    Write-ColorOutput "============================================================" "Cyan"
    Write-ColorOutput "     Toolchain Adapter v8 - Windows 工具调用协议适配器       " "Cyan"
    Write-ColorOutput "============================================================" "Cyan"
    Write-Host ""
}

# ─── 显示启动横幅 ───
Write-Banner

# ─── 检查 .env 文件 ───
if (-not (Test-Path ".env")) {
    Write-ColorOutput "[警告] 未找到 .env 文件，使用默认配置" "Yellow"
    if (Test-Path ".env.example") {
        Write-ColorOutput "[提示] 可以复制 .env.example 为 .env 并修改配置:" "Yellow"
        Write-ColorOutput "       Copy-Item .env.example .env" "Yellow"
    }
} else {
    Write-ColorOutput "[信息] 已加载 .env 配置文件" "Green"
}

# ─── 检查 Node.js ───
try {
    $nodeVersion = node -v
    $versionNumber = $nodeVersion -replace 'v', '' -split '\.' | Select-Object -First 1
    if ([int]$versionNumber -lt 18) {
        Write-ColorOutput "[错误] Node.js 版本过低，需要 18+，当前: $nodeVersion" "Red"
        exit 1
    }
    Write-ColorOutput "[信息] Node.js 版本: $nodeVersion" "Green"
} catch {
    Write-ColorOutput "[错误] 未找到 Node.js，请先安装 Node.js 18+" "Red"
    Write-ColorOutput "       下载地址: https://nodejs.org/" "Red"
    exit 1
}

# ─── 检查并安装依赖 ───
if (-not (Test-Path "node_modules")) {
    Write-ColorOutput "[信息] 正在安装依赖..." "Yellow"
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-ColorOutput "[错误] 依赖安装失败" "Red"
        exit 1
    }
    Write-ColorOutput "[信息] 依赖安装完成" "Green"
} else {
    # 检查依赖是否完整
    try {
        node -e "require('express'); require('axios'); require('jsonrepair'); require('uuid')" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-ColorOutput "[信息] 依赖不完整，正在重新安装..." "Yellow"
            npm install
        }
    } catch {
        Write-ColorOutput "[信息] 依赖不完整，正在重新安装..." "Yellow"
        npm install
    }
}

# ─── 确定后端类型 ───
$backendType = if ($env:BACKEND_TYPE) { $env:BACKEND_TYPE } else { "lmstudio" }

if ($backendType -eq "llamacpp") {
    # 检查 llama.cpp 服务器连接
    $llamacppUrl = if ($env:LLAMACPP_BASE_URL) { $env:LLAMACPP_BASE_URL } else { "http://localhost:8080" }
    Write-ColorOutput "[信息] 后端类型: llama.cpp 服务器" "Cyan"
    Write-ColorOutput "[信息] 检查 llama.cpp 连接: $llamacppUrl" "Cyan"

    try {
        $response = Invoke-WebRequest -Uri "$llamacppUrl/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        Write-ColorOutput "[信息] llama.cpp 服务器连接正常" "Green"
    } catch {
        Write-ColorOutput "[警告] 无法连接到 llama.cpp 服务器 ($llamacppUrl)" "Yellow"
        Write-ColorOutput "        请确保 llama-server 已启动并加载了模型" "Yellow"
        Write-ColorOutput "        启动命令示例:" "Yellow"
        Write-ColorOutput "        .\llama-server.exe -m model.gguf -c 8192 --port 8080" "Yellow"
        Write-ColorOutput "        或使用本项目的 start-llamacpp.ps1 辅助脚本" "Yellow"
        Write-ColorOutput "        适配器仍将启动，但请求会失败" "Yellow"
    }
} else {
    # 检查 LM Studio 连接
    $lmStudioUrl = if ($env:LM_STUDIO_BASE_URL) { $env:LM_STUDIO_BASE_URL } else { "http://localhost:1234" }
    Write-ColorOutput "[信息] 后端类型: LM Studio" "Cyan"
    Write-ColorOutput "[信息] 检查 LM Studio 连接: $lmStudioUrl" "Cyan"

    try {
        $response = Invoke-WebRequest -Uri "$lmStudioUrl/v1/models" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        Write-ColorOutput "[信息] LM Studio 连接正常" "Green"
    } catch {
        Write-ColorOutput "[警告] 无法连接到 LM Studio ($lmStudioUrl)" "Yellow"
        Write-ColorOutput "        请确保 LM Studio 已启动并加载了模型" "Yellow"
        Write-ColorOutput "        适配器仍将启动，但请求会失败" "Yellow"
    }
}

# ─── 启动适配器 ───
$adapterPort = if ($env:ADAPTER_PORT) { $env:ADAPTER_PORT } else { "3838" }
Write-ColorOutput "[信息] 启动适配器，端口: $adapterPort" "Cyan"
Write-Host ""

# 直接启动 Node.js 服务器
node server.js
