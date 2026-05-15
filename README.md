# OpenClaw Toolchain Adapter

<div align="center">

**The Protocol Adapter That Makes Agents Actually Work with Local Small Models**

 [中文](./README_zh_CN.md) | english

</div>

---

## Why Does This Project Exist?

When you try to make AI Agent frameworks like Claude Code, OpenClaw, AutoClaw, Hermes call locally-run small models (7B-14B parameters), you immediately hit three walls:

### Pain Point #1: Protocol Incompatibility

Agent frameworks universally use the Anthropic Messages API format, while local model servers (LM Studio, llama.cpp) use the OpenAI Chat Completions API format. The two differ fundamentally in tool calling, message structure, and streaming responses. **If they can't even talk to each other, how can they collaborate?**

### Pain Point #2: Small Models "Don't Know How to Use Tools"

Models with ~9B parameters suffer from systematic deficiencies in tool calling:
- **Simulated Calls**: The model describes "I'll call the xxx tool" in natural language instead of generating structured `tool_calls` JSON
- **Format Collapse**: Generated JSON is incomplete, misquoted, or structurally mangled — completely unparseable
- **Training Token Leakage**: Outputs training-specific control tokens like `<|tool_call|>`, `<|im_start|>`, etc.
- **Missing Examples**: Without Few-Shot examples, small models have no idea how to structure tool calls

### Pain Point #3: Agents Get Stuck in Infinite Loops

Small models in Agent scenarios are extremely prone to infinite loops, with diverse patterns that are hard to detect:
- **Repeated Same Tool**: Calling `web_search` 10 times consecutively with identical arguments
- **Alternating Loops**: `search → bash → search → bash → ...`, an A-B-A-B pattern
- **Semantic Equivalence Loops**: Repeatedly calling functionally identical tools with different phrasing
- **Stuck Output**: Repeatedly generating meaningless text like "I apologize, let me try again"

### Pain Point #4: Language Drift

Ask in Chinese, get an answer in English. This is especially severe with 9B models in tool-calling scenarios — they'll fill tool call arguments with Chinese, but the "reasoning process" and final reply are entirely in English.

### Pain Point #5: Context Amnesia

Small models have limited context windows (typically 4K-8K tokens). Multi-round tool calling in Agent workflows quickly exhausts the context budget. Once compressed, previous key decisions, tool results, and user instructions are all lost — **project amnesia**, and the Agent starts over from scratch repeating work already done.

---

## Ultimate Goals & Vision

| Goal | Current Status | Vision |
|------|---------------|--------|
| **Seamless Protocol Translation** | ✅ Anthropic ↔ OpenAI bidirectional conversion | Support more protocols (Google Gemini API, Mistral API, etc.) |
| **Small Model Tool-Calling Enhancement** | ✅ Few-Shot + JSON repair + simulated call fixing | Explore RLHF fine-tuning for native tool-calling ability |
| **Agent Infinite Loop Termination** | ✅ 7-layer progressive detection + escalating intervention | Explore LLM-based semantic loop detection beyond Jaccard similarity |
| **Multilingual Forced Output** | ✅ 9-language dual injection + response correction | Build small-model multilingual instruction fine-tuning datasets to solve the root cause |
| **Context Never Lost** | ⚠️ SSD memory store + auto-refinement + compression | Next-gen: Vector database-based semantic memory retrieval (RAG), cross-project knowledge transfer |

**Ultimate Vision**: Enable any Agent framework to call local small models as smoothly as calling GPT-4/Claude, achieving true AI Agent autonomous development on consumer-grade hardware.

---

## Feature List & Implementation Status

### Core Protocol Layer

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| Anthropic → OpenAI conversion | `protocol-converter.js` | ✅ Complete | Messages, tools, content blocks, full streaming conversion |
| OpenAI → Anthropic conversion | `protocol-converter.js` | ✅ Complete | Reverse conversion with real-time SSE translation |
| Tool call format conversion | `protocol-converter.js` | ✅ Complete | `tool_use`/`tool_result` ↔ `tool_calls`/`role:tool` |
| Dual endpoint support | `server.js` | ✅ Complete | `/v1/messages` + `/v1/chat/completions` |
| Streaming response conversion | `protocol-converter.js` | ✅ Complete | `StreamConverter` real-time SSE format translation |

### Backend Adapter Layer

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| LM Studio adapter | `backend-adapter.js` | ✅ Complete | Pass-through mode, OpenAI-compatible |
| llama.cpp adapter | `backend-adapter.js` | ✅ Complete | `parse_tool_calls` injection, `stop_type` mapping, `cache_prompt`, `reasoning_format` |
| Backend hot-swapping | `config.js` | ✅ Complete | Switch via `BACKEND_TYPE` environment variable |
| Backend health checks | `server.js` | ✅ Complete | LM Studio `/v1/models`, llama.cpp `/health` |

### Context Management

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| SSD persistent memory store | `memory-store.js` | ✅ Complete | Per-session JSON file persistence, Windows-safe atomic writes |
| Context auto-refinement | `context-refiner.js` | ✅ Complete | Extract key facts before compression, 6 conclusion patterns + 6 instruction patterns |
| Memory injection | `context-refiner.js` | ✅ Complete | Inject historical facts into system prompt as `[Memory - Key Facts from Previous Context]` |
| Token budget compression | `context-compressor.js` | ✅ Complete | Tool description truncation, schema simplification, old message summarization, tool count pruning |
| Session memory management | `server.js` | ✅ Complete | List/delete session memories, age-based auto-cleanup (default: 7 days) |
| Vector semantic memory retrieval | — | ❌ Not implemented | RAG-based semantic memory retrieval to replace current full-text injection |

### Agent Loop Prevention

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| Layer 0: Content hash consecutive repeat | `loop-detector.js` | ✅ Complete | Threshold 10, detects identical repeated requests |
| Layer 0.5: Window hash frequency | `loop-detector.js` | ✅ Complete | Threshold 15, detects A,B,A,B alternating patterns |
| Layer 1: Exact match | `loop-detector.js` | ✅ Complete | Threshold 3, same tool + same arguments |
| Layer 2: Tool name frequency | `loop-detector.js` | ✅ Complete | Threshold 5, ignoring argument differences |
| Layer 3: Semantic similarity | `loop-detector.js` | ✅ Complete | Jaccard word-set similarity > 0.5, threshold 4 |
| Layer 4: Global frequency | `loop-detector.js` | ✅ Complete | 2-minute window, threshold 10 |
| Layer R0: Response content repeat | `loop-detector.js` | ✅ Complete | Threshold 5, detects model stuck output |
| Escalating intervention | `loop-detector.js` | ✅ Complete | inject_message → strip_tools → force_end |
| Command content normalization | `loop-detector.js` | ✅ Complete | Replace timestamps, hashes, Base64 noise |
| LLM semantic loop detection | — | ❌ Not implemented | Deep semantic understanding beyond Jaccard |
| Loop root cause analysis | — | ❌ Not implemented | Auto-analyze why loops occur and adjust prompt strategy |

### Small Model Tool-Calling Enhancement

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| 3-level JSON repair | `json-repair.js` | ✅ Complete | Standard parse → jsonrepair library → regex brute-force extraction |
| Tool call arguments repair | `json-repair.js` | ✅ Complete | Specialized repair for malformed `function.arguments` JSON |
| Simulated call detection (6 patterns) | `simulated-call-fixer.js` | ✅ Complete | Parenthesized kwargs, colon style, "let me use", inline JSON, Action style, code block JSON |
| Simulated call conversion | `simulated-call-fixer.js` | ✅ Complete | Text description → structured `tool_calls` |
| Training token cleanup | `simulated-call-fixer.js` | ✅ Complete | Strip leaked `<\|tool_call\|>`, `<\|im_start\|>`, etc. |
| Few-Shot example injection | `few-shot-injector.js` | ✅ Complete | Auto-generate tool call examples from JSON Schema |
| Model family detection | `few-shot-injector.js` | ✅ Complete | Hermes/Qwen/Llama/Mistral/Phi/DeepSeek/Yi/ChatML — 8 families |
| Family-specific formatting | `few-shot-injector.js` | ✅ Complete | Different tool-call output formats per model family |

### Multilingual Support

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| 9-language support | `language-fixer.js` | ✅ Complete | zh-CN/zh-TW/zh/en/ja/ko/fr/de/es/ru |
| System prompt injection | `language-fixer.js` | ✅ Complete | Inject language preference into system prompt |
| User message injection | `language-fixer.js` | ✅ Complete | Append language preference to last user message (9B models respond better to recent messages) |
| Response language detection | `language-fixer.js` | ✅ Complete | Character-range-based detection (CJK/Hiragana/Hangul/Latin) |
| Response language correction | `language-fixer.js` | ✅ Complete | Prominent language notice header prepended when mismatched |
| Multilingual instruction fine-tuning | — | ❌ Not implemented | Solve small-model multilingual output at the root |

### Diagnostics & Logging

| Feature | Module | Status | Description |
|---------|--------|--------|-------------|
| Per-request diagnostic report | `diagnostic.js` | ✅ Complete | Colored console + plain-text file, tracking phases/issues/fixes/stats |
| Exception log persistence | `exception-logger.js` | ✅ Complete | JSON-lines format, 10MB auto-rotation |
| 10+ specialized log methods | `exception-logger.js` | ✅ Complete | Loop/abort/timeout/bad response/protocol error/language fix, etc. |
| Log query API | `server.js` | ✅ Complete | `/logs` endpoint with filtering |

### Windows-Specific Tooling

| Feature | File | Status | Description |
|---------|------|--------|-------------|
| PowerShell startup script | `start.ps1` | ✅ Complete | .env loading, environment checks, backend connectivity detection |
| One-click installer | `install.ps1` | ✅ Complete | Node.js detection, dependency install, .env configuration |
| llama.cpp launcher helper | `start-llamacpp.ps1` | ✅ Complete | CPU/GPU mode, custom port and context size |
| Windows filesystem compatibility | Multiple modules | ✅ Complete | 3-step atomic write, ENOENT-safe log rotation |
| Service management support | `DEPLOYMENT.md` | ✅ Complete | nssm registration, PM2 ecosystem config |

---

## Real-World Comparison Examples

### Example 1: Tool Calling — Without vs. With Adapter

**Scenario**: Agent requests to call `web_search` tool for "Beijing weather"

❌ **Without Adapter** (calling llama.cpp directly):

```
Model output:
"Let me search for Beijing weather for you. I'll call the web_search tool with query='Beijing weather'."
(Pure text, not structured tool_calls. Agent cannot parse it. Task fails.)
```

✅ **With Adapter**:

```
Adapter automatically:
1. Detects simulated call ("let me use" pattern)
2. Extracts tool name web_search and argument query='Beijing weather'
3. Converts to structured tool_calls: [{function: {name: "web_search", arguments: '{"query":"Beijing weather"}'}}]
4. Agent successfully receives the tool call and continues execution

→ Same model output, but the adapter makes it usable
```

### Example 2: Infinite Loop — Without vs. With 7-Layer Detection

**Scenario**: Agent repeatedly searches for the same error message while debugging

❌ **Without loop detection**:

```
Round 1: web_search("ModuleNotFoundError: flask")
Round 2: bash("pip install flask")
Round 3: web_search("ModuleNotFoundError: flask")      ← Repeat
Round 4: bash("pip install flask")                      ← Repeat
Round 5: web_search("ModuleNotFoundError: flask")      ← Repeat
Round 6: bash("pip install flask")                      ← Repeat
... (Infinite loop until tokens exhausted or user manually kills it)
```

✅ **With 7-layer loop detection**:

```
Round 1: web_search("ModuleNotFoundError: flask")      ← Normal
Round 2: bash("pip install flask")                      ← Normal
Round 3: web_search("ModuleNotFoundError: flask")      ← Layer 0.5 window frequency +1
Round 4: bash("pip install flask")                      ← Layer 0.5 window frequency +1
Round 5: web_search("ModuleNotFoundError: flask")      ← Layer 1 exact match triggered!
→ Intervention: inject_message "Loop detected, please try a different approach"
Round 6: Model receives intervention, tries new approach (e.g., checking Python path)
→ Loop terminated
```

### Example 3: Language Drift — Without vs. With Dual Injection Correction

**Scenario**: User asks in Chinese "帮我写一个 Python 快速排序" (Help me write a Python quicksort)

❌ **Without language correction**:

```
Model output:
"Sure! Here's a Python implementation of quicksort:
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    ..."
(User asks in Chinese, model answers in English — jarring experience)
```

✅ **With dual injection + response correction**:

```
Adapter processing:
1. System prompt injection: "Please always respond in Chinese (zh-CN)"
2. Last user message appended: "[Please respond in Chinese]"
3. When model output is still in English:
   → Language mismatch detected
   → Header prepended: "[System Notice: The model responded in English, but the user requested Chinese]"
   → Agent sees the language marker and can re-request a Chinese response

Model corrected output:
"好的！这是一个 Python 快速排序的实现：
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    ..."
```

### Example 4: Context Amnesia — Without vs. With SSD Persistent Memory

**Scenario**: Agent in a 30-round long task, first 5 rounds already determined the project uses React + TypeScript

❌ **Without memory storage**:

```
Round 25 (after context compression):
Agent: "Let me check what framework the project uses..."
→ Completely forgets that React + TypeScript was already confirmed. Re-confirms.
→ Wastes tokens, reduces efficiency, user frustration
```

✅ **With SSD persistent memory + auto-refinement**:

```
Round 5 (refinement phase):
→ Context refiner extracts key fact: "Project uses React + TypeScript tech stack"
→ Saved to memory/session-abc123.json

Round 25 (after compression):
→ Load memory from SSD: [Memory - Key Facts from Previous Context]
  - "Project uses React + TypeScript tech stack"
  - "Dependencies installed: react, typescript, @types/react"
  - "Entry file: src/App.tsx"
→ Agent continues work based on memory, no need to re-confirm
```

---

## Architecture Overview

```
                          ┌──────────────────────────────┐
                          │       Agent Framework        │
                          │  (Claude Code / OpenHands)   │
                          └──────────┬───────────────────┘
                                     │ Anthropic Messages API
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Toolchain Adapter (port 3838)                    │
│                                                                      │
│  Request Pipeline:                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐      │
│  │ protocol       │→│ context        │→│ context           │      │
│  │ converter      │  │ refiner        │  │ compressor        │      │
│  └────────────────┘  └───────┬────────┘  └──────────────────┘      │
│                              │ memory-store (SSD)                   │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐      │
│  │ few-shot       │→│ language       │→│ loop              │      │
│  │ injector       │  │ fixer          │  │ detector          │      │
│  └────────────────┘  └────────────────┘  └──────────────────┘      │
│                                                     │               │
│  ┌────────────────┐                                 │               │
│  │ backend        │←────────────────────────────────┘               │
│  │ adapter        │                                                  │
│  └───────┬────────┘                                                  │
│          │                                                           │
│   ┌──────┴───────┐                                                   │
│   ▼              ▼                                                   │
│  ┌─────────┐  ┌──────────┐     Response Pipeline:                   │
│  │LM Studio│  │llama.cpp │     1. parseResponse (backend-specific)  │
│  │  :1234  │  │  :8080   │     2. json-repair                       │
│  └────┬────┘  └────┬─────┘     3. simulated-call-fixer              │
│       │            │           4. response loop detection            │
│       └─────┬──────┘           5. language-fixer                     │
│             │                  6. protocol-converter (→Anthropic)    │
│             ▼                                                       │
│     Return to Agent Framework                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Requirements

| Component | Requirement |
|-----------|-------------|
| OS | Windows 10/11 or Windows Server 2019+ |
| Node.js | >= 18.0.0 |
| PowerShell | >= 5.1 |
| LM Studio | Installed with model loaded (or use llama.cpp instead) |
| RAM | >= 8GB recommended (including model memory) |

### Install & Launch

```powershell
# 1. Clone the repository
git clone https://github.com/MyBirdVery6/openclaw-toolchain-adapter.git
cd openclaw-toolchain-adapter

# 2. One-click install
.\install.ps1

# 3. Configure environment variables (optional)
notepad .env

# 4. Start the adapter
.\start.ps1
```

### Using llama.cpp Backend

```powershell
# Launch llama-server (helper script)
.\start-llamacpp.ps1 -ModelPath D:\models\qwen2.5-7b-instruct-q4_k_m.gguf -Port 8080 -GPULayers 32

# Switch to llama.cpp backend
$env:BACKEND_TYPE = "llamacpp"
.\start.ps1
```

### Configure Your Agent Framework

In Claude Code or other Agent frameworks, point the API Base URL to the adapter:

```
API Base URL: http://localhost:3838
```

The adapter provides both Anthropic-format and OpenAI-format endpoints with automatic compatibility.

---

## Project File Structure

```
toolchain-adapter/
├── server.js                # Main server entry, request processing pipeline
├── config.js                # Centralized configuration (30+ env variables)
├── protocol-converter.js    # Anthropic ↔ OpenAI bidirectional protocol conversion
├── backend-adapter.js       # Multi-backend adapter layer (LM Studio / llama.cpp)
├── memory-store.js          # SSD persistent memory storage
├── context-refiner.js       # Context auto-refinement (extract key facts before compression)
├── context-compressor.js    # Token budget context compression
├── loop-detector.js         # 7-layer loop/infinite-loop detection + escalating intervention
├── json-repair.js           # 3-level JSON repair engine
├── few-shot-injector.js     # Per-model-family tool call example injection
├── simulated-call-fixer.js  # Simulated tool call detection & conversion
├── language-fixer.js        # Multilingual injection & response correction
├── diagnostic.js            # Per-request diagnostic report system
├── exception-logger.js      # Exception log persistence (JSON-lines)
├── start.ps1                # PowerShell startup script
├── start-llamacpp.ps1       # llama.cpp launcher helper script
├── install.ps1              # Windows one-click installer
├── package.json             # Project configuration
├── test/                    # TDD test suites (70 tests)
│   ├── test-backend-adapter.js
│   ├── test-memory-store.js
│   └── test-context-refiner.js
├── logs/                    # Runtime log directory
└── memory/                  # Runtime memory storage directory
```

---

## Current Limitations & Known Issues

We honestly list the current shortcomings of this project. We hope to brainstorm and solve these together:

### 🔴 Critical Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| **Context compression is lossy** | High | Current compression strategy truncates tool descriptions + summarizes old messages, which may lose important details. The ideal approach is semantic importance-based selective retention, rather than simple length-based pruning |
| **Loop detection is rule-based, not semantic** | High | All 7 detection layers are based on hashing, frequency, and Jaccard similarity. They cannot understand "expressing the same intent with different words" — deep semantic loops. This requires LLM-in-the-loop semantic loop detection, but LLM calls themselves introduce latency and cost |
| **Memory retrieval is full-text injection, not semantic** | High | Currently all historical facts are injected into the system prompt. When memory accumulates too much, it actually increases the context burden. Should use a vector database for RAG-style on-demand retrieval, only injecting memories relevant to the current task |
| **Language correction is a patch, not a cure** | Medium | Current dual injection + response correction is just a "band-aid". The root solution requires the small model itself to have stable multilingual output capability, which needs instruction fine-tuning |

### 🟡 Feature Gaps

| Issue | Description |
|-------|-------------|
| **Only LM Studio and llama.cpp supported** | Does not support Ollama, vLLM, LocalAI, or other popular local model servers |
| **No cross-platform support** | Current scripts and file operations are optimized for Windows only; Linux/macOS needs adaptation |
| **No streaming JSON repair** | Malformed JSON in streaming responses cannot currently be fixed in real-time; must wait for the complete response |
| **No diagnostic visualization** | Currently only console text and file logs; lacks a Web panel or chart-based diagnostic interface |
| **No quantization-level adaptive tuning** | Models at different quantization levels (Q2_K to Q8_0) have vastly different capabilities. The adapter currently uses the same parameters for all; it should auto-adjust Few-Shot count, compression thresholds, etc. based on quantization level |

### 🟡 Stability Issues

| Issue | Description |
|-------|-------------|
| **Performance degradation with extreme long contexts** | When messages exceed 100 rounds, protocol conversion and loop detection performance significantly degrades |
| **Concurrent request handling** | Currently single-threaded Express; may become a bottleneck under high concurrency |
| **Incomplete llama.cpp error handling** | llama.cpp returns diverse error formats; some edge cases are not covered |

---

## 🤝 Call for Contributors: We Need Your Power!

OpenClaw Toolchain Adapter solves the most basic problem of Agents calling local small models — **getting them to work at all**. But there's a long way to go before they **work well**. Here are the areas where we most need community power — each is an independently contributable direction:

### 🏆 High-Priority Contribution Areas

1. **RAG-Based Semantic Memory Retrieval**
   - Replace current full-text memory injection with a vector database (ChromaDB / Qdrant / FAISS)
   - Implement semantically-relevant memory retrieval based on the current task, injecting only necessary historical context
   - Tech stack: Node.js + Vector database + Embedding model

2. **LLM-in-the-Loop Semantic Loop Detection**
   - When rule-based layers detect a suspected loop, call a lightweight LLM to determine if it's a true semantic repetition
   - Balance detection accuracy vs. latency: use small model for quick judgment, large model for final confirmation
   - Design fallback strategy: revert to rule-based detection when LLM call fails

3. **More Backend Adapters: Ollama / vLLM / LocalAI**
   - Each backend has its own API quirks (e.g., Ollama's `/api/chat` format, vLLM's continuous batching)
   - Follow the existing factory pattern in `backend-adapter.js` to add new adapters

4. **Cross-Platform Support: Linux / macOS**
   - Rewrite PowerShell scripts as cross-platform shell scripts
   - Fix Windows-specific filesystem operations (e.g., 3-step atomic rename)
   - Add Docker deployment solution

### 🎯 Medium-Priority Contribution Areas

5. **Streaming JSON Repair**: Real-time detection and fixing of malformed JSON in SSE streams
6. **Diagnostic Web Panel**: Real-time display of request processing status and loop detection events via WebSocket
7. **Quantization-Level Adaptive Tuning**: Auto-adjust adapter parameters based on model quantization level
8. **Multilingual Fine-Tuning Datasets**: Build small-model multilingual tool-calling instruction datasets
9. **Performance Optimization**: Async pipeline processing, streaming intermediate results, reduce memory copies

### How to Contribute

- **Submit Issues**: Report bugs, suggest features, share usage experiences
- **Submit PRs**: Code contributions should include corresponding TDD test cases
- **Share Experiences**: Usage results across different models and hardware configurations help refine Few-Shot and loop detection parameters
- **Write Documentation**: Supplement deployment tutorials, model recommendation lists, best practice guides

---

## Tech Stack

- **Runtime**: Node.js >= 18.0.0
- **Web Framework**: Express 4.x
- **HTTP Client**: Axios 1.x
- **JSON Repair**: jsonrepair 3.x
- **Platform**: Windows 10/11 (PowerShell 5.1+)
- **Backends**: LM Studio / llama.cpp
- **Testing**: Node.js built-in assert + custom async test runner (70 TDD tests)
- **License**: GNU General Public License v3.0

---

## License

**GNU General Public License v3.0**

---

<div align="center">
**If this project helped you, please give it a ⭐ Star!**

**Let every consumer-grade PC run a real AI Agent.**

</div>

---
# OpenClaw Toolchain Adapter

<div align="center">

**让 Agent 真正能调用本地小模型的协议适配器**

[English](./README_en.md) | 中文

</div>

---

## 为什么需要这个项目？

当你尝试让 Claude Code、OpenClaw、AutoClaw、Hermes 等 AI Agent 框架调用本地运行的小模型（7B-14B）时，你会立刻撞上三堵墙：

### 痛点一：协议不兼容

Agent 框架普遍使用 Anthropic Messages API 格式，而本地模型服务器（LM Studio、llama.cpp）使用 OpenAI Chat Completions API 格式。两者在工具调用、消息结构、流式响应方面存在根本差异。**连话都说不上，何谈协作？**

### 痛点二：小模型"不会用工具"

9B 参数量的模型在工具调用方面存在系统性缺陷：
- **模拟调用**：用自然语言描述"我来调用 xxx 工具"，而不是生成结构化的 `tool_calls` JSON
- **格式崩溃**：生成的 JSON 格式残缺、引号错位、嵌套混乱，根本无法解析
- **训练标记泄漏**：输出 `<|tool_call|>`、`<|im_start|>` 等训练专用的控制标记
- **示例缺失**：小模型没有 Few-Shot 示例就不知道如何组织工具调用

### 痛点三：Agent 陷入死循环

小模型在 Agent 场景下极易进入死循环，模式多样且难以检测：
- **重复调用同一工具**：连续 10 次调用 `web_search` 传入相同参数
- **交替式死循环**：`search → bash → search → bash → ...`，A-B-A-B 模式
- **语义等价循环**：用不同的措辞反复调用功能相同的工具
- **卡死输出**：反复生成"I apologize, let me try again"等无意义文本

### 痛点四：语言漂移

用中文提问，模型用英文回答。9B 小模型在工具调用场景下尤其严重——它会在工具调用参数中填中文，但工具调用的"思考过程"和最终回复全是英文。

### 痛点五：上下文失忆

小模型上下文窗口有限（通常 4K-8K），Agent 的多轮工具调用很快就会撑爆上下文。一旦压缩，之前的关键决策、工具返回结果、用户指令全部丢失——**项目失忆**，Agent 从零开始重复已做过的工作。

---

## 项目终极目标与展望

| 目标 | 当前状态 | 展望 |
|------|---------|------|
| **协议无缝转换** | ✅ 已实现 Anthropic ↔ OpenAI 双向转换 | 支持更多协议（Google Gemini API、Mistral API 等） |
| **小模型工具调用增强** | ✅ Few-Shot + JSON 修复 + 模拟调用修复 | 探索 RLHF 微调让小模型原生学会工具调用 |
| **Agent 死循环终结** | ✅ 7 层渐进式检测 + 升级干预 | 探索基于 LLM 的语义循环检测，超越 Jaccard 相似度 |
| **多语言强制输出** | ✅ 9 种语言双注入 + 响应修正 | 构建小模型多语言指令微调数据集，从根上解决 |
| **上下文永不丢失** | ⚠️ SSD 记忆存储 + 自动提炼 + 压缩 | 下一代：基于向量数据库的语义记忆检索（RAG），跨项目知识迁移 |

**终极愿景**：让任何 Agent 框架都能像调用 GPT-4/Claude 一样流畅地调用本地小模型，在消费级硬件上实现真正的 AI Agent 自主开发。

---

## 功能清单与实现状态

### 核心协议层

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| Anthropic → OpenAI 协议转换 | `protocol-converter.js` | ✅ 完整 | 消息、工具、内容块、流式全量转换 |
| OpenAI → Anthropic 协议转换 | `protocol-converter.js` | ✅ 完整 | 反向转换，含流式 SSE 实时翻译 |
| 工具调用格式转换 | `protocol-converter.js` | ✅ 完整 | `tool_use`/`tool_result` ↔ `tool_calls`/`role:tool` |
| 双端点支持 | `server.js` | ✅ 完整 | `/v1/messages` + `/v1/chat/completions` |
| 流式响应转换 | `protocol-converter.js` | ✅ 完整 | `StreamConverter` 实时 SSE 格式翻译 |

### 后端适配层

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| LM Studio 适配 | `backend-adapter.js` | ✅ 完整 | 透传模式，OpenAI 兼容 |
| llama.cpp 适配 | `backend-adapter.js` | ✅ 完整 | `parse_tool_calls` 注入、`stop_type` 映射、`cache_prompt`、`reasoning_format` |
| 后端热切换 | `config.js` | ✅ 完整 | 通过 `BACKEND_TYPE` 环境变量切换 |
| 后端健康检查 | `server.js` | ✅ 完整 | LM Studio `/v1/models`、llama.cpp `/health` |

### 上下文管理

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| SSD 永久记忆存储 | `memory-store.js` | ✅ 完整 | 按 Session ID 持久化为 JSON 文件，Windows 原子写入 |
| 上下文自动提炼 | `context-refiner.js` | ✅ 完整 | 压缩前提取关键事实，6 种结论模式 + 6 种指令模式 |
| 记忆注入 | `context-refiner.js` | ✅ 完整 | 将历史事实注入系统提示 `[Memory - Key Facts from Previous Context]` |
| Token 预算压缩 | `context-compressor.js` | ✅ 完整 | 工具描述截断、Schema 简化、旧消息摘要、工具数量裁剪 |
| 会话记忆管理 | `server.js` | ✅ 完整 | 列出/删除会话记忆，按年龄自动清理（默认 7 天） |
| 向量语义记忆检索 | — | ❌ 未实现 | 基于 RAG 的语义记忆检索，替代当前的全文注入 |

### Agent 死循环防护

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| Layer 0：内容哈希连续重复 | `loop-detector.js` | ✅ 完整 | 阈值 10，检测完全相同的重复请求 |
| Layer 0.5：窗口哈希频率 | `loop-detector.js` | ✅ 完整 | 阈值 15，检测 A,B,A,B 交替模式 |
| Layer 1：精确匹配 | `loop-detector.js` | ✅ 完整 | 阈值 3，同工具 + 同参数 |
| Layer 2：工具名频率 | `loop-detector.js` | ✅ 完整 | 阈值 5，忽略参数差异 |
| Layer 3：语义相似度 | `loop-detector.js` | ✅ 完整 | Jaccard 词集相似度 > 0.5，阈值 4 |
| Layer 4：全局频率 | `loop-detector.js` | ✅ 完整 | 2 分钟窗口内阈值 10 |
| Layer R0：响应内容重复 | `loop-detector.js` | ✅ 完整 | 阈值 5，检测模型卡死输出 |
| 升级干预 | `loop-detector.js` | ✅ 完整 | inject_message → strip_tools → force_end |
| 命令内容归一化 | `loop-detector.js` | ✅ 完整 | 替换时间戳、哈希、Base64 等噪声 |
| LLM 语义循环检测 | — | ❌ 未实现 | 超越 Jaccard 的深层语义理解 |
| 循环根因分析 | — | ❌ 未实现 | 自动分析为何进入循环并调整提示策略 |

### 小模型工具调用增强

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| 3 级 JSON 修复 | `json-repair.js` | ✅ 完整 | 标准 parse → jsonrepair 库 → 正则暴力提取 |
| 工具调用参数修复 | `json-repair.js` | ✅ 完整 | 专门修复 `function.arguments` 中的畸形 JSON |
| 模拟调用检测（6 种模式） | `simulated-call-fixer.js` | ✅ 完整 | 括号式、冒号式、let me use、内联 JSON、Action 式、代码块式 |
| 模拟调用转换 | `simulated-call-fixer.js` | ✅ 完整 | 文本描述 → 结构化 `tool_calls` |
| 训练标记清理 | `simulated-call-fixer.js` | ✅ 完整 | 清理 `<\|tool_call\|>`、`<\|im_start\|>` 等泄漏标记 |
| Few-Shot 示例注入 | `few-shot-injector.js` | ✅ 完整 | 从 JSON Schema 自动生成工具调用示例 |
| 模型家族识别 | `few-shot-injector.js` | ✅ 完整 | Hermes/Qwen/Llama/Mistral/Phi/DeepSeek/Yi/ChatML 8 家族 |
| 家族专属格式 | `few-shot-injector.js` | ✅ 完整 | 不同模型家族使用不同的工具调用输出格式 |

### 多语言支持

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| 9 种语言支持 | `language-fixer.js` | ✅ 完整 | zh-CN/zh-TW/zh/en/ja/ko/fr/de/es/ru |
| 系统提示注入 | `language-fixer.js` | ✅ 完整 | 在系统提示中注入语言偏好指令 |
| 用户消息注入 | `language-fixer.js` | ✅ 完整 | 在最后一条用户消息中追加语言偏好（9B 模型更关注近期消息） |
| 响应语言检测 | `language-fixer.js` | ✅ 完整 | 基于字符范围分析（CJK/平假名/韩文/拉丁） |
| 响应语言修正 | `language-fixer.js` | ✅ 完整 | 语言不匹配时在内容头部添加醒目标记 |
| 多语言指令微调 | — | ❌ 未实现 | 从根上解决小模型多语言输出能力 |

### 诊断与日志

| 功能 | 模块 | 状态 | 说明 |
|------|------|------|------|
| 逐请求诊断报告 | `diagnostic.js` | ✅ 完整 | 彩色控制台 + 纯文本文件，跟踪阶段/问题/修复/统计 |
| 异常日志持久化 | `exception-logger.js` | ✅ 完整 | JSON-lines 格式，10MB 自动轮转 |
| 10+ 专项日志方法 | `exception-logger.js` | ✅ 完整 | 循环/中止/超时/错误响应/协议错误/语言修正等 |
| 日志查询 API | `server.js` | ✅ 完整 | `/logs` 端点，支持过滤 |

### Windows 专用工具

| 功能 | 文件 | 状态 | 说明 |
|------|------|------|------|
| PowerShell 启动脚本 | `start.ps1` | ✅ 完整 | .env 加载、环境检测、后端连通性检查 |
| 一键安装脚本 | `install.ps1` | ✅ 完整 | Node.js 检测、依赖安装、.env 配置 |
| llama.cpp 启动辅助 | `start-llamacpp.ps1` | ✅ 完整 | CPU/GPU 模式、自定义端口和上下文大小 |
| Windows 文件系统兼容 | 多个模块 | ✅ 完整 | 3 步原子写入、ENOENT 安全日志轮转 |
| 服务管理支持 | `DEPLOYMENT.md` | ✅ 完整 | nssm 注册、PM2 生态配置 |

---

## 实际对比示例

### 示例 1：工具调用 — 没有适配器 vs 有适配器

**场景**：Agent 请求调用 `web_search` 工具搜索"北京天气"

❌ **没有适配器**（直接调用 llama.cpp）：

```
模型输出：
"我来帮你搜索一下北京天气。让我调用 web_search 工具，参数是 query='北京天气'。"
（纯文本，不是结构化 tool_calls，Agent 无法解析，任务失败）
```

✅ **有适配器**：

```
适配器自动处理：
1. 检测到模拟调用（"let me use" 模式）
2. 提取工具名 web_search 和参数 query='北京天气'
3. 转换为结构化 tool_calls: [{function: {name: "web_search", arguments: '{"query":"北京天气"}'}}]
4. Agent 成功接收到工具调用，继续执行

→ 同样的模型输出，适配器让它变得可用
```

### 示例 2：死循环 — 没有检测 vs 7 层检测

**场景**：Agent 在调试代码时反复搜索相同错误信息

❌ **没有循环检测**：

```
Round 1: web_search("ModuleNotFoundError: flask")
Round 2: bash("pip install flask")
Round 3: web_search("ModuleNotFoundError: flask")     ← 重复
Round 4: bash("pip install flask")                     ← 重复
Round 5: web_search("ModuleNotFoundError: flask")     ← 重复
Round 6: bash("pip install flask")                     ← 重复
... (无限循环，直到 Token 耗尽或用户手动终止)
```

✅ **7 层循环检测**：

```
Round 1: web_search("ModuleNotFoundError: flask")     ← 正常
Round 2: bash("pip install flask")                     ← 正常
Round 3: web_search("ModuleNotFoundError: flask")     ← Layer 0.5 窗口频率 +1
Round 4: bash("pip install flask")                     ← Layer 0.5 窗口频率 +1
Round 5: web_search("ModuleNotFoundError: flask")     ← Layer 1 精确匹配触发！
→ 干预：inject_message "检测到循环，请尝试不同的解决方法"
Round 6: 模型收到干预，尝试新方法（如检查 Python 路径）
→ 循环终止
```

### 示例 3：语言漂移 — 没有修正 vs 双注入修正

**场景**：用户用中文提问"帮我写一个 Python 快速排序"

❌ **没有语言修正**：

```
模型输出：
"Sure! Here's a Python implementation of quicksort:
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    ..."
（用户问中文，模型答英文，体验割裂）
```

✅ **双注入 + 响应修正**：

```
适配器处理：
1. 系统提示注入："请始终使用中文(zh-CN)回复"
2. 最后用户消息追加："[请使用中文回复]"
3. 模型输出仍为英文时：
   → 检测到语言不匹配
   → 在内容头部添加 "[系统提示：以下内容模型使用English回复，用户要求使用中文]"
   → Agent 看到语言标记后可重新请求中文回复

模型修正后输出：
"好的！这是一个 Python 快速排序的实现：
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    ..."
```

### 示例 4：上下文失忆 — 没有记忆 vs SSD 永久记忆

**场景**：Agent 在一个 30 轮的长任务中，前 5 轮已确定了项目使用 React + TypeScript

❌ **没有记忆存储**：

```
Round 25（上下文压缩后）：
Agent: "我来检查一下项目使用什么框架..."
→ 完全忘记之前已确认 React + TypeScript，重复确认
→ 浪费 Token，降低效率，用户崩溃
```

✅ **SSD 永久记忆 + 自动提炼**：

```
Round 5（提炼阶段）：
→ 上下文提炼器提取关键事实："项目使用 React + TypeScript 技术栈"
→ 保存到 memory/session-abc123.json

Round 25（压缩后）：
→ 从 SSD 加载记忆：[Memory - Key Facts from Previous Context]
  - "项目使用 React + TypeScript 技术栈"
  - "已安装依赖：react, typescript, @types/react"
  - "入口文件：src/App.tsx"
→ Agent 直接基于记忆继续工作，无需重复确认
```

---

## 架构概览

```
                          ┌──────────────────────────────┐
                          │       Agent Framework        │
                          │  (Claude Code / OpenHands)   │
                          └──────────┬───────────────────┘
                                     │ Anthropic Messages API
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Toolchain Adapter (port 3838)                    │
│                                                                      │
│  Request Pipeline:                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐      │
│  │ protocol       │→│ context        │→│ context           │      │
│  │ converter      │  │ refiner        │  │ compressor       │      │
│  └────────────────┘  └───────┬────────┘  └──────────────────┘      │
│                              │ memory-store (SSD)                   │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐      │
│  │ few-shot       │→│ language       │→│ loop              │      │
│  │ injector       │  │ fixer          │  │ detector          │      │
│  └────────────────┘  └────────────────┘  └──────────────────┘      │
│                                                     │               │
│  ┌────────────────┐                                 │               │
│  │ backend        │←────────────────────────────────┘               │
│  │ adapter        │                                                  │
│  └───────┬────────┘                                                  │
│          │                                                           │
│   ┌──────┴───────┐                                                   │
│   ▼              ▼                                                   │
│  ┌─────────┐  ┌──────────┐     Response Pipeline:                   │
│  │LM Studio│  │llama.cpp │     1. parseResponse (backend-specific)  │
│  │  :1234  │  │  :8080   │     2. json-repair                       │
│  └────┬────┘  └────┬─────┘     3. simulated-call-fixer              │
│       │            │           4. response loop detection            │
│       └─────┬──────┘           5. language-fixer                     │
│             │                  6. protocol-converter (→Anthropic)    │
│             ▼                                                       │
│     Return to Agent Framework                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 环境要求

| 组件 | 要求 |
|------|------|
| 操作系统 | Windows 10/11 或 Windows Server 2019+ |
| Node.js | >= 18.0.0 |
| PowerShell | >= 5.1 |
| LM Studio | 已安装并加载模型（或使用 llama.cpp 替代） |
| 内存 | 建议 >= 8GB（含模型内存） |

### 安装与启动

```powershell
# 1. 克隆仓库
git clone https://github.com/MyBirdVery6/openclaw-toolchain-adapter.git
cd openclaw-toolchain-adapter

# 2. 一键安装
.\install.ps1

# 3. 配置环境变量（可选）
notepad .env

# 4. 启动适配器
.\start.ps1
```

### 使用 llama.cpp 后端

```powershell
# 启动 llama-server（辅助脚本）
.\start-llamacpp.ps1 -ModelPath D:\models\qwen2.5-7b-instruct-q4_k_m.gguf -Port 8080 -GPULayers 32

# 切换到 llama.cpp 后端
$env:BACKEND_TYPE = "llamacpp"
.\start.ps1
```

### 配置 Agent 框架

在 Claude Code 或其他 Agent 框架中，将 API Base URL 指向适配器：

```
API Base URL: http://localhost:3838
```

适配器同时提供 Anthropic 格式和 OpenAI 格式的端点，自动兼容。

---

## 项目文件结构

```
toolchain-adapter/
├── server.js                # 主服务入口，请求处理管线
├── config.js                # 集中配置管理（30+ 环境变量）
├── protocol-converter.js    # Anthropic ↔ OpenAI 双向协议转换
├── backend-adapter.js       # 多后端适配层（LM Studio / llama.cpp）
├── memory-store.js          # SSD 永久记忆存储
├── context-refiner.js       # 上下文自动提炼（压缩前提取关键事实）
├── context-compressor.js    # Token 预算上下文压缩
├── loop-detector.js         # 7 层循环/死循环检测 + 升级干预
├── json-repair.js           # 3 级 JSON 修复引擎
├── few-shot-injector.js     # 按模型家族注入工具调用示例
├── simulated-call-fixer.js  # 模拟工具调用检测与转换
├── language-fixer.js        # 多语言注入与响应修正
├── diagnostic.js            # 逐请求诊断报告系统
├── exception-logger.js      # 异常日志持久化（JSON-lines）
├── start.ps1                # PowerShell 启动脚本
├── start-llamacpp.ps1       # llama.cpp 启动辅助脚本
├── install.ps1              # Windows 一键安装脚本
├── package.json             # 项目配置
├── test/                    # TDD 测试用例（70 个测试）
│   ├── test-backend-adapter.js
│   ├── test-memory-store.js
│   └── test-context-refiner.js
├── logs/                    # 运行时日志目录
└── memory/                  # 运行时记忆存储目录
```

---

## 当前缺陷与已知问题

我们坦诚地列出当前项目的不足，希望能集思广益，共同解决：

### 🔴 关键缺陷

| 问题 | 严重程度 | 说明 |
|------|---------|------|
| **上下文压缩为有损压缩** | 高 | 当前压缩策略是截断工具描述 + 摘要旧消息，可能导致重要细节丢失。理想的方案是基于语义重要性的选择性保留，而非简单的长度裁剪 |
| **循环检测基于规则而非语义理解** | 高 | 7 层检测全部基于哈希、频率和 Jaccard 相似度，无法理解"用不同的词表达了相同的意图"这种深层语义循环。需要 LLM-in-the-loop 的语义循环检测，但 LLM 调用本身又引入延迟和成本 |
| **记忆检索为全文注入而非语义检索** | 高 | 当前将所有历史事实全部注入系统提示，当记忆积累过多时反而增加了上下文负担。应该用向量数据库做 RAG 式的按需检索，只注入与当前任务相关的记忆 |
| **语言修正是治标不治本** | 中 | 当前的双注入 + 响应修正只是"打补丁"，根本解决方案需要小模型本身具备稳定的多语言输出能力，这需要指令微调 |

### 🟡 功能缺口

| 问题 | 说明 |
|------|------|
| **仅支持 LM Studio 和 llama.cpp** | 不支持 Ollama、vLLM、LocalAI 等其他流行的本地模型服务器 |
| **不支持非 Windows 平台** | 当前脚本和文件操作均针对 Windows 优化，Linux/macOS 需要适配 |
| **不支持流式 JSON 修复** | 流式响应中的畸形 JSON 目前无法实时修复，只能等完整响应后处理 |
| **诊断报告缺少可视化** | 当前只有控制台文本和文件日志，缺少 Web 面板或图表化的诊断界面 |
| **缺少模型量化等级自适应** | 不同量化等级（Q2_K 到 Q8_0）的模型能力差异大，当前适配器使用同一套参数，应该根据量化等级自动调整 Few-Shot 数量、压缩阈值等 |

### 🟡 稳定性问题

| 问题 | 说明 |
|------|------|
| **极端长上下文下性能下降** | 当消息超过 100 轮时，协议转换和循环检测的性能显著下降 |
| **并发请求处理** | 当前为单线程 Express，高并发下可能成为瓶颈 |
| **llama.cpp 特殊错误处理不完整** | llama.cpp 返回的错误格式多样，部分边缘情况未被覆盖 |

---

## 🤝 召集令：我们需要你的力量！

OpenClaw Toolchain Adapter 解决了 Agent 调用本地小模型的最基本问题——**能跑起来**。但距离**跑得好**还有很长的路。以下是我们最需要社区力量的问题，每一个都是独立可贡献的方向：

### 🏆 高优先级贡献方向

1. **基于 RAG 的语义记忆检索**
   - 用向量数据库（ChromaDB / Qdrant / FAISS）替换当前的全文记忆注入
   - 实现按当前任务语义检索相关记忆，只注入必要的历史上下文
   - 技术栈：Node.js + 向量数据库 + Embedding 模型

2. **LLM-in-the-Loop 语义循环检测**
   - 当规则层检测到疑似循环时，调用一次轻量 LLM 判断是否为真正的语义重复
   - 平衡检测准确性与延迟：用小模型做快速判断，大模型做最终确认
   - 需要设计好 fallback 策略：LLM 调用失败时退回规则检测

3. **更多后端适配：Ollama / vLLM / LocalAI**
   - 每个后端有自己的 API 特殊性（如 Ollama 的 `/api/chat` 格式、vLLM 的连续批处理）
   - 参照现有 `backend-adapter.js` 的工厂模式，添加新的适配器

4. **跨平台支持：Linux / macOS**
   - 将 PowerShell 脚本改写为跨平台 Shell 脚本
   - 修复 Windows 特定的文件系统操作（如原子写入的 3 步 rename）
   - 添加 Docker 部署方案

### 🎯 中优先级贡献方向

5. **流式 JSON 修复**：在 SSE 流中实时检测和修复畸形 JSON
6. **诊断 Web 面板**：用 WebSocket 实时展示请求处理状态和循环检测事件
7. **量化等级自适应**：根据模型量化等级自动调整适配参数
8. **多语言微调数据集**：构建小模型多语言工具调用指令数据集
9. **性能优化**：异步管道处理、流式中间结果传递、减少内存拷贝

### 贡献方式

- **提交 Issue**：报告 Bug、提出功能建议、分享使用经验
- **提交 PR**：代码贡献请附上对应的 TDD 测试用例
- **分享经验**：在不同模型和硬件配置下的使用效果，帮助完善 Few-Shot 和循环检测参数
- **撰写文档**：补充部署教程、模型推荐清单、最佳实践指南

---

## 技术栈

- **运行时**：Node.js >= 18.0.0
- **Web 框架**：Express 4.x
- **HTTP 客户端**：Axios 1.x
- **JSON 修复**：jsonrepair 3.x
- **平台**：Windows 10/11（PowerShell 5.1+）
- **后端**：LM Studio / llama.cpp
- **测试**：Node.js 内置 assert + 自定义异步测试运行器（70 个 TDD 测试）
- **许可证**：GNU General Public License v3.0

---

## 许可证

**GNU General Public License v3.0**

---

<div align="center">

**如果这个项目帮助到了你，请给个 ⭐ Star！**

**让每一台消费级电脑都能跑起真正的 AI Agent。**

**此项目抛砖引玉，请大神赐教，一起解决大家共性的问题吧！**

</div>

---

