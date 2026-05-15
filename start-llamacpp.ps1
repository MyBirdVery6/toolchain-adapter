# ==============================================================================
# llama.cpp 服务器 Windows 启动辅助脚本
# 用于在 Windows 上快速启动 llama-server 并加载模型
# ==============================================================================

param(
    [string]$ModelPath = "",
    [int]$Port = 8080,
    [int]$ContextSize = 8192,
    [int]$GPULayers = 0,
    [string]$LlamaServerPath = "llama-server.exe"
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

# ─── 显示帮助 ───
if ($ModelPath -eq "" -or $ModelPath -eq "-h" -or $ModelPath -eq "--help") {
    Write-Host ""
    Write-Status "用法: .\start-llamacpp.ps1 -ModelPath <模型路径> [选项]" "Cyan"
    Write-Host ""
    Write-Host "参数:"
    Write-Host "  -ModelPath      模型文件路径 (.gguf)，必填"
    Write-Host "  -Port           服务器端口，默认 8080"
    Write-Host "  -ContextSize    上下文窗口大小，默认 8192"
    Write-Host "  -GPULayers      GPU 层数，0=仅CPU，默认 0"
    Write-Host "  -LlamaServerPath llama-server.exe 路径，默认在 PATH 中查找"
    Write-Host ""
    Write-Host "示例:"
    Write-Host "  .\start-llamacpp.ps1 -ModelPath D:\models\qwen2.5-7b.gguf"
    Write-Host "  .\start-llamacpp.ps1 -ModelPath .\model.gguf -Port 9090 -GPULayers 32"
    Write-Host ""
    exit 0
}

# ─── 检查模型文件 ───
if (-not (Test-Path $ModelPath)) {
    Write-Status "[错误] 模型文件不存在: $ModelPath" "Red"
    Write-Status "       请指定正确的 .gguf 模型文件路径" "Yellow"
    exit 1
}

# ─── 检查 llama-server ───
$serverExe = $LlamaServerPath
if (-not (Get-Command $serverExe -ErrorAction SilentlyContinue)) {
    # 尝试在当前目录查找
    if (Test-Path ".\llama-server.exe") {
        $serverExe = ".\llama-server.exe"
    } else {
        Write-Status "[错误] 未找到 llama-server.exe" "Red"
        Write-Status "       请从 https://github.com/ggml-org/llama.cpp/releases 下载" "Yellow"
        Write-Status "       或使用 -LlamaServerPath 参数指定路径" "Yellow"
        exit 1
    }
}

# ─── 构建启动参数 ───
$llamaArgs = @(
    "-m", $ModelPath,
    "-c", $ContextSize,
    "--port", $Port,
    "--host", "0.0.0.0"
)

if ($GPULayers -gt 0) {
    $llamaArgs += @("-ngl", $GPULayers)
}

# ─── 显示启动信息 ───
Write-Host ""
Write-Status "============================================================" "Cyan"
Write-Status "  llama.cpp 服务器启动                                      " "Cyan"
Write-Status "============================================================" "Cyan"
Write-Host ""
Write-Status "  模型:      $ModelPath" "White"
Write-Status "  端口:      $Port" "White"
Write-Status "  上下文:    $ContextSize tokens" "White"
Write-Status "  GPU 层:    $(if ($GPULayers -gt 0) { $GPULayers } else { 'CPU only' })" "White"
Write-Host ""
Write-Status "  启动命令:  $serverExe $($llamaArgs -join ' ')" "DarkGray"
Write-Host ""

# ─── 启动 llama-server ───
Write-Status "[信息] 正在启动 llama-server..." "Green"
& $serverExe @llamaArgs
