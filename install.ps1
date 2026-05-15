# ==============================================================================
# Toolchain Adapter v8 - Windows 一键安装脚本
# 自动检测环境、安装依赖、配置 .env
# ==============================================================================

$ErrorActionPreference = "Stop"

# 切换到脚本所在目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-Status {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host ""
    Write-Status "[$Step] $Message" "Cyan"
    Write-Status ("-" * 50) "DarkGray"
}

Write-Host ""
Write-Status "============================================================" "Green"
Write-Status "  Toolchain Adapter v8 - Windows 安装向导                    " "Green"
Write-Status "============================================================" "Green"
Write-Host ""

# ─── 步骤1: 检查 Node.js ───
Write-Step "1/5" "检查 Node.js 环境"

try {
    $nodeVersion = node -v
    $majorVersion = [int]($nodeVersion -replace 'v', '' -split '\.' | Select-Object -First 1)
    if ($majorVersion -lt 18) {
        Write-Status "[失败] Node.js 版本 $nodeVersion 过低，需要 18+" "Red"
        Write-Status "       下载地址: https://nodejs.org/" "Yellow"
        exit 1
    }
    Write-Status "[通过] Node.js $nodeVersion" "Green"
} catch {
    Write-Status "[失败] 未安装 Node.js" "Red"
    Write-Status "       请从 https://nodejs.org/ 下载安装 Node.js 18+" "Yellow"
    exit 1
}

# ─── 步骤2: 检查 npm ───
Write-Step "2/5" "检查 npm 包管理器"

try {
    $npmVersion = npm -v
    Write-Status "[通过] npm $npmVersion" "Green"
} catch {
    Write-Status "[失败] npm 不可用" "Red"
    exit 1
}

# ─── 步骤3: 安装依赖 ───
Write-Step "3/5" "安装项目依赖"

if (Test-Path "node_modules") {
    Write-Status "[信息] node_modules 已存在，检查依赖完整性..." "Yellow"
    try {
        node -e "require('express'); require('axios'); require('jsonrepair'); require('uuid')" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Status "[通过] 依赖已完整" "Green"
        } else {
            Write-Status "[信息] 依赖不完整，重新安装..." "Yellow"
            npm install --production
        }
    } catch {
        npm install --production
    }
} else {
    Write-Status "[信息] 首次安装，正在下载依赖..." "Yellow"
    npm install --production
    if ($LASTEXITCODE -ne 0) {
        Write-Status "[失败] 依赖安装失败" "Red"
        exit 1
    }
    Write-Status "[通过] 依赖安装完成" "Green"
}

# ─── 步骤4: 配置 .env ───
Write-Step "4/5" "配置环境变量"

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Status "[信息] 已从 .env.example 创建 .env" "Green"
        Write-Status "[提示] 请根据需要编辑 .env 文件:" "Yellow"
        Write-Status "       notepad .env" "Yellow"
    } else {
        Write-Status "[警告] 未找到 .env.example，请手动创建 .env" "Yellow"
    }
} else {
    Write-Status "[通过] .env 文件已存在" "Green"
}

# ─── 步骤5: 创建必要目录 ───
Write-Step "5/5" "创建工作目录"

$dirs = @("logs", "memory")
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Status "[信息] 创建目录: $dir" "Green"
    } else {
        Write-Status "[通过] 目录已存在: $dir" "Green"
    }
}

# ─── 完成 ───
Write-Host ""
Write-Status "============================================================" "Green"
Write-Status "  安装完成！                                                " "Green"
Write-Status "============================================================" "Green"
Write-Host ""
Write-Status "快速启动方式:" "Cyan"
Write-Host ""
Write-Status "  1. 使用 PowerShell 脚本启动 (推荐):" "White"
Write-Status "     .\start.ps1" "White"
Write-Host ""
Write-Status "  2. 使用 npm 启动:" "White"
Write-Status "     npm start" "White"
Write-Host ""
Write-Status "  3. 指定 llama.cpp 后端启动:" "White"
Write-Status "     `$env:BACKEND_TYPE='llamacpp'; .\start.ps1" "White"
Write-Host ""
Write-Status "  4. 注册为 Windows 服务 (需管理员权限):" "White"
Write-Status "     参见 DEPLOYMENT.md 中的 nssm 配置说明" "White"
Write-Host ""
