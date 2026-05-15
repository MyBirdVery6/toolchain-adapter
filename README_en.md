# OpenClaw Toolchain Adapter

<div align="center">

**The Protocol Adapter That Makes Agents Actually Work with Local Small Models**

 [中文](./README_zh_CN.md) | english

</div>

---

## Why Does This Project Exist?

When you try to make AI Agent frameworks like Claude Code, OpenHands, or SWE-agent call locally-run small models (7B-14B parameters), you immediately hit three walls:

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
- **License**: MIT

---

## License

**GNU General Public License v3.0**

---

<div align="center">
**If this project helped you, please give it a ⭐ Star!**

**Let every consumer-grade PC run a real AI Agent.**

</div>

---
