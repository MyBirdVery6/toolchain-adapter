#!/bin/bash
# Toolchain Adapter v7 启动脚本
# 支持 LM Studio 和 llama.cpp 两种后端

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     Toolchain Adapter v7 - 工具调用协议适配器    ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo -e "${YELLOW}[警告] 未找到 .env 文件，使用默认配置${NC}"
    if [ -f .env.example ]; then
        echo -e "${YELLOW}[提示] 可以复制 .env.example 为 .env 并修改配置${NC}"
        echo -e "${YELLOW}       cp .env.example .env${NC}"
    fi
else
    echo -e "${GREEN}[信息] 已加载 .env 配置文件${NC}"
fi

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}[错误] 未找到 Node.js，请先安装 Node.js 18+${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}[错误] Node.js 版本过低，需要 18+，当前: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}[信息] Node.js 版本: $(node -v)${NC}"

# 检查并安装依赖
if [ ! -d node_modules ]; then
    echo -e "${YELLOW}[信息] 正在安装依赖...${NC}"
    npm install
    echo -e "${GREEN}[信息] 依赖安装完成${NC}"
else
    # 检查依赖是否完整
    if ! node -e "require('express'); require('axios'); require('jsonrepair'); require('uuid')" 2>/dev/null; then
        echo -e "${YELLOW}[信息] 依赖不完整，正在重新安装...${NC}"
        npm install
    fi
fi

# 确定后端类型
BACKEND_TYPE="${BACKEND_TYPE:-lmstudio}"

if [ "$BACKEND_TYPE" = "llamacpp" ]; then
    # 检查 llama.cpp 服务器连接
    LLAMACPP_URL="${LLAMACPP_BASE_URL:-http://localhost:8080}"
    echo -e "${CYAN}[信息] 后端类型: llama.cpp 服务器${NC}"
    echo -e "${CYAN}[信息] 检查 llama.cpp 连接: ${LLAMACPP_URL}${NC}"

    if curl -s --connect-timeout 3 "${LLAMACPP_URL}/health" > /dev/null 2>&1; then
        echo -e "${GREEN}[信息] llama.cpp 服务器连接正常${NC}"
    else
        echo -e "${YELLOW}[警告] 无法连接到 llama.cpp 服务器 (${LLAMACPP_URL})${NC}"
        echo -e "${YELLOW}        请确保 llama-server 已启动并加载了模型${NC}"
        echo -e "${YELLOW}        启动命令示例: ./llama-server -m model.gguf -c 8192 --port 8080${NC}"
        echo -e "${YELLOW}        适配器仍将启动，但请求会失败${NC}"
    fi
else
    # 检查 LM Studio 连接
    LM_STUDIO_URL="${LM_STUDIO_BASE_URL:-http://localhost:1234}"
    echo -e "${CYAN}[信息] 后端类型: LM Studio${NC}"
    echo -e "${CYAN}[信息] 检查 LM Studio 连接: ${LM_STUDIO_URL}${NC}"

    if curl -s --connect-timeout 3 "${LM_STUDIO_URL}/v1/models" > /dev/null 2>&1; then
        echo -e "${GREEN}[信息] LM Studio 连接正常${NC}"
    else
        echo -e "${YELLOW}[警告] 无法连接到 LM Studio (${LM_STUDIO_URL})${NC}"
        echo -e "${YELLOW}        请确保 LM Studio 已启动并加载了模型${NC}"
        echo -e "${YELLOW}        适配器仍将启动，但请求会失败${NC}"
    fi
fi

# 启动适配器
ADAPTER_PORT="${ADAPTER_PORT:-3838}"
echo -e "${CYAN}[信息] 启动适配器，端口: ${ADAPTER_PORT}${NC}"
echo ""

node server.js
