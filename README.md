# CC2LLM

> - AUTHOR: [LostAbaddon](lostabaddon@gmail.com)
> - VERSION: 2.3.1

将 Claude Code / Claude Cowork / Codex CLI / Codex App / Gemini CLI 请求透明转发到多厂商 LLM 的桥接代理，支持自动话题分类、智能路由和 Web 管理面板。

## 功能

- **多客户端支持** — Claude Code、Claude Cowork、Codex CLI、Codex App、Gemini CLI 均可通过同一代理端口接入，各自使用原生协议（Anthropic / OpenAI / Gemini）
- **多厂商支持** — Anthropic、OpenAI、Gemini 三种协议兼容，覆盖 DeepSeek / Google / Moonshot / MiniMax / OpenRouter 等十余家厂商
- **多 Key 负载均衡** — `apiKey` 支持数组格式，基于内存级加权随机算法实现多租户流量均衡；自动识别鉴权/欠费/业务错误标记 Key 状态并自愈
- **自动模式（Auto Mode）** — 内置话题分类器，根据对话内容自动匹配最佳工作模式（编程 / 写作 / 研究 / 规划等），无需手动切换模型
- **跨协议转换** — Anthropic ↔ OpenAI ↔ Gemini 请求/响应格式自动互转，保留 streaming、tool use、thinking 等高级特性
- **内置工具翻译** — 自动识别并翻译 Claude Code / Codex / Gemini 客户端的 `web_search` / `web_fetch` 内置工具到目标 Provider 接受的格式（如 DeepSeek 的 `web_search_20260209`、Google 的 `googleSearch`），不支持时回落为占位响应，保证多轮 tool_use 链路不断裂
- **用量追踪** — 按天/周/月/年统计各 Provider/Model 的调用次数和 Token 消耗，管理面板内置可视化图表
- **Web 管理面板** — 可视化编辑 Provider、Model Mapping、Agent（Working Mode）、Prompt，无需重启服务即时生效
- **配置热生效** — 直接编辑 `config.json` 保存即可即时生效，与网页端保存行为一致；无需重启服务
- **Token 与缓存优化** — 自动拦截 Claude 工具发出的防护性/计费请求，清除会破坏上游 Prompt Cache 的干扰标头，显著降低实际 Token 消耗并提升缓存命中率

## 快速开始

```bash
git clone git@github.com:LostAbaddon/cc2llm.git
cd cc2llm

# 复制并填写配置
cp config.template.json config.json
# 编辑 config.json，填入各厂商 API Key

npm start          # 启动代理 + 管理面板
npm start claude   # 启动代理后自动拉起 Claude Code TUI
npm start codex    # 启动代理后自动拉起 Codex CLI
npm start gemini   # 启动代理后自动拉起 Gemini CLI
npm start wui      # 在浏览器打开管理面板
```

- 代理服务：`http://127.0.0.1:8764`（各客户端配置此地址）
- 管理面板：`http://127.0.0.1:8765`

## 客户端接入

cc2llm 的代理端口（默认 `:8764`）同时接受三种原生 API 协议，根据 URL 路径自动识别客户端类型：

| 客户端 | 原生协议 | 关键 URL 路径 |
|--------|---------|-------------|
| Claude Code / Cowork | Anthropic Messages API | `/v1/messages` |
| Codex CLI / Codex App | OpenAI Chat Completions API | `/v1/chat/completions` |
| Gemini CLI | Google Gemini API | `/v1beta/models/{model}:generateContent` |

### Claude Code 接入

**方式一：环境变量 + CLI 参数（推荐）**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8764
export ANTHROPIC_AUTH_TOKEN=cc2llm
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
export CLAUDE_YOLO=1
claude --dangerously-skip-permissions --allow-dangerously-skip-permissions \
  --exclude-dynamic-system-prompt-sections \
  --settings '{"includeGitInstructions":false}'
```

**方式二：Claude Code 设置文件**

在 Claude Code 设置中将 API Base URL 指向 cc2llm：

```json
{
  "apiBaseUrl": "http://127.0.0.1:8764",
  "apiKey": "any-value"
}
```

**方式三：一键启动**

```bash
npm start claude
```

该命令自动设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 两个基础环境变量，并以免权限确认模式启动 Claude Code。如需启用方式一中的高级变量（禁用非核心流量、YOLO 模式等），请手动设置环境变量后使用方式一启动。

### Claude Cowork 接入

与 Claude Code 接入方式相同，Cowork 基于同一 Anthropic 协议：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8764
export ANTHROPIC_AUTH_TOKEN=cc2llm

claude-cowork
```

或将 cc2llm 的配置填入 Cowork 的 API 设置中。

### Codex CLI 接入

Codex CLI 使用 OpenAI Chat Completions API 协议，cc2llm 在代理端口自动识别并处理。

#### 安装 Codex CLI

```bash
# npm 全局安装
npm install -g @openai/codex

# 或 Homebrew (macOS)
brew install --cask codex
```

#### 配置方式

**方式一：一键启动（最简单）**

```bash
npm start codex
```

该命令自动设置环境变量并启动 Codex CLI。

**方式二：环境变量**

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8764/codex
export OPENAI_API_KEY=cc2llm

codex
```

> `OPENAI_BASE_URL` 末尾**必须带 `/codex`**，这是 Codex CLI 的要求，与 Claude Code 不同。

**方式三：配置文件（推荐持久化）**

创建 `~/.codex/config.toml`：

```toml
# ~/.codex/config.toml
model           = "gpt-5.4"
model_provider  = "cc2llm"
openai_base_url = "http://127.0.0.1:8764/codex"

[model_providers.cc2llm]
name     = "CC2LLM Bridge"
base_url = "http://127.0.0.1:8764/codex"
wire_api = "chat"
env_key  = "OPENAI_API_KEY"
```

配合环境变量：

```bash
export OPENAI_API_KEY=cc2llm
codex
```

> **关于 `wire_api`**：Codex CLI 0.81.0+ 默认使用 `"responses"`（Responses API），但大多数中转服务只支持 Chat Completions API。如果你的后端 Provider 只支持 Chat，请设置 `wire_api = "chat"`。

#### Model Mapping 配置

Codex CLI 发送的模型名是 OpenAI 风格（如 `gpt-5.4`、`gpt-5`、`codex-4`、`o4-mini`、`o3`），需要在 cc2llm 的 `modelMapping` 中添加对应映射：

```json
{
  "prefix": "gpt-5.4",
  "provider": "deepseek",
  "target": "deepseek-v4-pro"
},
{
  "prefix": "gpt-5",
  "provider": "deepseek",
  "target": "deepseek-v4-pro"
},
{
  "prefix": "codex",
  "provider": "deepseek",
  "target": "deepseek-v4-pro"
},
{
  "prefix": "o4",
  "provider": "deepseek",
  "target": "deepseek-v4-pro"
},
{
  "prefix": "o3",
  "provider": "deepseek",
  "target": "deepseek-v4-pro"
}
```

> 映射规则：按 `prefix` 长度降序匹配，`gpt-5.4` 会优先命中 `gpt-5.4` 前缀而非 `gpt-5`。
>
> 以上示例中的模型名（`gpt-5.4`、`deepseek-v4-pro` 等）为演示前缀，实际使用时请参考 `config.template.json` 中的最新配置或将你所用客户端实际发送的模型名填入映射。

#### 验证配置

```bash
# 确认版本
codex --version

# 确认环境变量
echo $OPENAI_BASE_URL
echo $OPENAI_API_KEY

# 运行诊断（部分版本支持）
codex doctor
```

### Codex App（桌面版）接入

Codex 桌面版与 CLI 共用 `~/.codex/config.toml`，但额外需要一个**模型目录文件**来让桌面版识别自定义模型。

#### 第一步：创建模型目录文件

创建 `~/.codex/model-catalogs/all-models.json`：

```json
{
  "models": [
    {
      "slug": "deepseek-v4-pro",
      "display_name": "DeepSeek V4 Pro (via CC2LLM)",
      "description": "Routed through CC2LLM bridge proxy",
      "visibility": "list",
      "supported_in_api": true,
      "context_window": 131072,
      "max_context_window": 131072,
      "effective_context_window_percent": 95,
      "auto_compact_token_limit": 196608,
      "input_modalities": ["text", "image"],
      "supports_image_detail_original": true,
      "supports_parallel_tool_calls": true,
      "supports_search_tool": false,
      "web_search_tool_type": "text_and_image",
      "apply_patch_tool_type": "freeform",
      "shell_type": "shell_command",
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "auto",
      "default_reasoning_level": "medium",
      "support_verbosity": true,
      "default_verbosity": "low",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "priority": 10
    }
  ]
}
```

#### 第二步：配置 config.toml

`~/.codex/config.toml`：

```toml
# 模型目录文件（必须写在根级别）
model_catalog_json = "~/.codex/model-catalogs/all-models.json"

model           = "deepseek-v4-pro"
model_provider  = "cc2llm"
openai_base_url = "http://127.0.0.1:8764/codex"

[model_providers.cc2llm]
name     = "CC2LLM Bridge"
base_url = "http://127.0.0.1:8764/codex"
wire_api = "chat"
env_key  = "OPENAI_API_KEY"
```

#### 第三步：设置环境变量并启动

```bash
export OPENAI_API_KEY=cc2llm
# 启动 Codex 桌面应用
```

> `model_catalog_json` 必须写在 `config.toml` **根级别**，不能放在 provider 配置段内。Provider ID（如 `cc2llm`）不能使用系统保留名（`openai`、`ollama`、`lmstudio` 等）。

### Gemini CLI 接入

Gemini CLI 使用 Google Gemini 原生 API 协议，cc2llm 在代理端口自动识别并处理。

#### 安装 Gemini CLI

```bash
npm install -g @google/gemini-cli
```

#### 配置方式

**方式一：一键启动（最简单）**

```bash
npm start gemini
```

该命令自动设置环境变量并启动 Gemini CLI。

**方式二：环境变量**

```bash
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8764
export GEMINI_API_KEY=cc2llm

gemini
```

> `GOOGLE_GEMINI_BASE_URL` 末尾**无需**带路径前缀，Gemini CLI 会自动追加 `/v1beta/models/...`。

**方式三：配置文件**

创建 `~/.gemini/settings.json`：

```json
{
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  }
}
```

配合环境变量启动。

#### Model Mapping 配置

Gemini CLI 发送的模型名是 Google 风格（如 `gemini-2.5-pro`、`gemini-2.5-flash`、`gemini-3-pro-preview`），需要在 cc2llm 的 `modelMapping` 中添加对应映射：

```json
{
  "prefix": "gemini-2.5",
  "provider": "google",
  "target": "gemini-3.1-flash-lite-preview"
},
{
  "prefix": "gemini-3",
  "provider": "google",
  "target": "gemini-3.1-pro-preview"
}
```

也可以将 Gemini CLI 的请求路由到非 Gemini 的后端（如 DeepSeek），cc2llm 会自动做 Gemini ↔ Anthropic 协议转换：

```json
{
  "prefix": "gemini-2.5",
  "provider": "deepseek",
  "target": "deepseek-v4-pro"
}
```

#### 常见注意事项

1. **OAuth 缓存冲突**：如果之前用 Google 账号登录过 Gemini CLI，OAuth 缓存可能导致 `GOOGLE_GEMINI_BASE_URL` 被忽略。建议清除缓存后重新配置，或者使用 API Key 认证模式。
2. **Docker 沙箱**：Gemini CLI 启用 `sandbox: true` 后，`GOOGLE_*_BASE_URL` 环境变量不会传递到沙箱内部，仅有 `GEMINI_API_KEY` 被保留。使用 cc2llm 时建议关闭沙箱或使用其他隔离方式。
3. **API Key 作为 Query 参数**：Gemini CLI 默认将 API Key 放在 URL Query String（`?key=...`）中传递，cc2llm 会自动处理。

### 多客户端同时使用

cc2llm 支持多个不同协议的客户端同时连接到同一代理端口：

```bash
# 终端 1: 启动代理
npm start

# 终端 2: 启动 Claude Code
npm start claude

# 终端 3: 启动 Codex CLI
npm start codex

# 终端 4: 启动 Gemini CLI
npm start gemini
```

所有客户端共享同一套 Provider 配置、Model Mapping 和 Auto Mode 设置，管理面板统一管理。

### 模型名映射总结

cc2llm 使用统一的 `modelMapping` 前缀匹配机制处理所有客户端的模型名。以下是一个覆盖三种客户端的完整示例：

```json
"modelMapping": [
  { "prefix": "claude-opus",  "target": "deepseek-v4-pro",             "provider": "deepseek" },
  { "prefix": "claude-sonnet", "target": "deepseek-v4-pro",             "provider": "auto" },
  { "prefix": "claude-haiku",  "target": "deepseek-v4-flash",           "provider": "deepseek" },
  { "prefix": "gpt-5.4",      "target": "deepseek-v4-pro",             "provider": "deepseek" },
  { "prefix": "gpt-5",        "target": "deepseek-v4-pro",             "provider": "deepseek" },
  { "prefix": "codex",        "target": "deepseek-v4-pro",             "provider": "deepseek" },
  { "prefix": "o4",           "target": "deepseek-v4-pro",             "provider": "deepseek" },
  { "prefix": "o3",           "target": "deepseek-v4-pro",             "provider": "deepseek" },
  { "prefix": "gemini-2.5",   "target": "gemini-3.1-flash-lite-preview", "provider": "google" },
  { "prefix": "gemini-3",     "target": "gemini-3.1-pro-preview",       "provider": "google" }
]
```

前缀匹配规则：
- 按 `prefix` 长度降序排列，优先命中更具体的前缀
- `gpt-5.4` → 优先命中 `gpt-5.4`（长度 6），而非 `gpt-5`（长度 5）
- `gemini-2.5-flash` → 命中 `gemini-2.5` 前缀
- 空字符串 `prefix` 作为兜底匹配，通常无需设置

> 以上示例中的模型名均为演示前缀。实际使用时请根据 `config.template.json` 中的最新配置和你所用客户端实际发送的模型名来编写映射规则。

## 配置

`config.json` 结构：

```json
{
  "server": { "port": 8764, "host": "127.0.0.1", "adminPort": 8765 },
  "defaultMaxTokens": 131072,
  "providers": { ... },
  "agents": { ... },
  "modelMapping": [ ... ],
  "modeCacheTtl": 60,
  "conversationGroups": 5,
  "logLevel": "info"
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `modeCacheTtl` | number | 60 | Auto Mode 分类结果缓存时间（秒），期间同 session 内跳过重复分类 |
| `conversationGroups` | number | 5 | 分类器保留的最近 N 组对话（user→assistant），超出部分裁剪 |

### Providers（模型厂商）

每个 Provider 代表一个模型服务商。支持三种协议类型：

| type | 说明 | 示例厂商 |
|------|------|---------|
| `anthropic` | Anthropic Messages API 兼容 | DeepSeek |
| `openai` | OpenAI Chat Completions 兼容 | Moonshot, MiniMax, OpenRouter |
| `gemini` | Google Gemini API 原生 | Google Gemini |
| `auto` | 自动路由（无需 apiKey） | — |

```json
"deepseek": {
  "type": "anthropic",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.deepseek.com/anthropic",
  "proxy": "",
  "models": [
    { "name": "deepseek-v4-pro", "maxTokens": 393216 },
    { "name": "deepseek-v4-flash", "maxTokens": 393216 }
  ],
  "defaultMaxTokens": 393216
}
```

maxTokens 查找优先级（三层）：模型级 `models[].maxTokens` → Provider 级 `defaultMaxTokens` → 全局 `defaultMaxTokens` → 131072。

#### 多 API Key 负载均衡

`apiKey` 字段支持**数组格式**来配置同 Provider 的多个 Key。服务会基于内存级加权随机算法自动分配请求到不同 Key，实现故障自愈与负载均衡：

```json
"deepseek": {
  "type": "anthropic",
  "apiKey": ["sk-key1-xxx", "sk-key2-xxx", "sk-key3-xxx"],
  "baseUrl": "..."
}
```

**算法特性：**
- **动态权重**：每次选择 Key 时，根据各 Key 的可用状态、当前并发数、历史完成数计算权重，均衡流量
- **故障感知**：4XX 鉴权错误 / 2XX 中嵌入的业务错误 → 标记 Key 为不可用（权重降为 30），但不完全禁用
- **Provider 级异常**：连接失败 / 5XX → 记录 Provider 级状态，不影响各 Key 的可用性标记
- **自愈机制**：标记为不可用的 Key 若后续成功返回，立即恢复为可用（权重回到 100）
- **绝不卡死**：所有 Key 均不可用时，以 30:30:... 等权重继续分发，一旦任一 Key 成功即回升

**状态查看**：管理面板 `API > Key States` 可查看每个 Provider 的所有 Key 实时状态（可用性、并发数、完成数）。

### Model Mapping（模型名映射）

将客户端传入的模型名按前缀匹配路由到目标厂商：

```json
"modelMapping": [
  { "prefix": "claude-opus",  "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "gpt-5.4",      "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "gemini-2.5",   "target": "gemini-2.5-pro",   "provider": "google" },
  { "prefix": "auto",         "target": "auto",             "provider": "auto" }
]
```

匹配规则：
- 按 `prefix` 长度降序排列，优先命中更具体的前缀
- `claude-opus-4-7-20250805` → `deepseek-v4-pro`（前缀 `claude-opus` 命中第一条）
- 空字符串 `prefix` 作为兜底匹配
- 未匹配任何前缀 → 返回 400 错误
- **通配符前缀**：`prefix` 中可包含 `*`，如 `"gpt-*-mini"`，等价于正则 `/^gpt-.*-mini/`。通配规则排在所有精确规则之后匹配；同组内按 `prefix` 字符串长度降序

`provider` 为 `auto` 时，`target` 可以是数组：每次命中按权重选取一个 spec（详见下文「多模型加权路由」）。例如：

```json
{
  "prefix": "auto",
  "target": ["deepseek/deepseek-v4-pro", "google/gemini-3.1-pro-preview"],
  "provider": "auto"
}
```

### Auto Mode / Agents（智能路由）

当 `provider` 设为 `auto` 时，cc2llm 会使用内置的话题分类器自动选择合适的模型：

```
用户输入 → 话题分类器（classifier）→ 匹配 Working Mode → 路由到对应模型
```

`agents` 配置支持多套配置集（Config Set），每套定义 Working Mode 与模型的对应关系。每个 mode 支持三种写法：

```json
"agents": {
  "defaults": {
    "default":  "deepseek/deepseek-v4-pro",
    "quick":    "google/gemini-3.5-flash",

    "plan":     ["google/gemini-3.1-pro-preview"],

    "code": {
      "description": "当需要阅读、修改、编写代码，或者设计网页端、APP 端，或者设计并操作数据库，或者进行架构分析与设计，等等一系列和编程、软件开发、软件设计相关的任务时，优先选用本模式",
      "models":      "minimax/minimax-m3"
    },
    "research": {
      "description": "当需要进行严肃思考、头脑风暴、学术讨论时，优先选用本模式",
      "models": [
        "google/gemini-3.1-pro-preview-customtools",
        "deepseek/deepseek-v4-pro",
        "minimax/minimax-m3"
      ]
    }
  },
  "fast": {
    "default": "deepseek/deepseek-v4-flash",
    "quick":   "deepseek/deepseek-v4-flash",
    "code":    "deepseek/deepseek-v4-pro"
  }
}
```

mode 值三种写法（可混用）：
- **字符串**：`"deepseek/deepseek-v4-pro"`，最简形式
- **字符串数组**：`["spec1", "spec2"]`，每次命中按权重选择一个（详见下文「多模型加权路由」）
- **对象**：`{ "description": "...", "models": "spec" | ["spec", ...] }`，可附带 `description` 帮助分类器识别场景，`models` 可为字符串或数组

其它约定：
- `defaults` — 默认配置集，modelMapping 中 `target: "auto"` 时使用
- 命名配置集 — 在 modelMapping 中设置 `target` 为配置集名称（如 `"fast"`）即可切换整套模式映射
- `default` — 每个配置集内的兜底模式，分类器未命中时使用
- `quick` — 分类器自身使用的轻量模型（用于快速判断话题）。支持 Anthropic / OpenAI / Gemini 三种协议的 Provider
- 其余 key — 自定义工作模式（如 `plan` / `code` / `writing` / `research`），分类器根据对话内容自动匹配

分类提示词可在管理面板的 **Prompts** 标签页实时编辑，或直接修改 `prompts/classifier.md`（分类 prompt）和 `prompts/classifier-system.md`（system prompt）。

### Auto Mode 高级特性

- **Session 持久化** — 每个会话维护当前工作模式，非文本输入（tool call 结果等）自动延续当前 mode 不触发重新分类
- **Mode 缓存** — `modeCacheTtl` 秒内同一 session 的分类结果被缓存复用
- **分类器多协议** — quick 模型可以是 Anthropic/OpenAI/Gemini 任一协议的 Provider
- **对话裁剪** — `conversationGroups` 控制送入分类器的最近对话组数

### 多模型加权路由（Model Router）

当某个 mode 的 `models` 字段、或 modelMapping 中 `provider: "auto"` 的 `target` 数组、或 quick 模式的 `models` 数组存在**多个候选项**时，cc2llm 使用**加权随机算法**来选择本次请求实际使用的 provider/model。

#### 权重计算公式

对候选项 `c`，实际权重为：

```
weight = link_weight(c.provider) / (max_done + 1) * (c.num_done + 1) * (max_doing + 1) / (c.num_doing + 1)
```

其中：
- `link_weight(provider)` — 该 provider 的连接权重（初始 100，每次"不可用"事件 ×0.9，每次"从不可用恢复"事件 ×1.1）
- `num_done` — 该 provider/model **成功**完成的任务数（失败不计入）
- `num_doing` — 该 provider/model **当前正在执行**的任务数
- `max_done` / `max_doing` — 候选项数组中 `num_done` / `num_doing` 的最大值
- 公式中所有 `+1` 用于避免除零

**直觉**：成功完成任务越多，被选中概率越大；正在执行的任务越多，被选中概率越小。这避免了对热门 provider/model 的过载。

#### Provider 健康度感知

`link_weight` 会随 provider 实际运行情况自动调整（数据从 `key-state-manager` 现有机制获取，**不重复维护**）：

| 事件 | link_weight 变化 |
|------|------------------|
| 任务失败，provider 被判定为不可用 | × `LINK_WEIGHT_DOWN_FACTOR`（默认 0.9） |
| 任务成功，provider 从不可用恢复 | × `LINK_WEIGHT_UP_FACTOR`（默认 1.1） |
| 任务成功，provider 原本就可用 | 不变 |
| 任务失败，provider 原本就不可用 | × 0.9（持续压低） |

> "持续压低"是预期行为——provider 持续故障时，权重会逐次降至 0.9 → 0.81 → 0.729 → …，直到几乎不被选中。当 provider 恢复后一次任务成功即开始回升（× 1.1）。

#### 失败重试

每次任务完成（无论成功或失败）都会立即更新所有统计。

**任务失败时**：
- 重新加权选模型，从相同 `models[]` 数组中重新抽取
- 允许抽到同一个 provider/model 作为重试（不强制过滤）
- 最多 `MAX_RETRY_ATTEMPTS` 次（默认 3，含首次）
- 全部失败才返回最后一次错误给 Copilot；只要中间有任意一次成功，调用方看不到任何错误

**业务请求和 Classifier Quick 请求都遵循此重试规则**——两者各自有独立的重试循环。

#### 数组不去重

候选项数组**不会自动去重**。如果用户在 `models` 中输入两个完全相同的 `provider/model` 字符串，相当于把该候选项的概率人为放大 2 倍。这是规则允许的干预手段，例如：

```json
"code": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro", "google/gemini-3.1-pro"]
```

效果：deepseek 整体被选中的概率约 2/3，gemini 约 1/3。

#### 热加载重置

`config.json` 热重载时，所有 `link_weight`、`num_done`、`num_doing` 全量清空，回到初始状态。

#### 可调参数

所有可调参数均定义为 `lib/model-router.js` 文件顶部常量，修改后重启即可生效，无需写死在调用处：

```javascript
const LINK_WEIGHT_DOWN_FACTOR = 0.9;   // provider 不可用时 link_weight 下调系数
const LINK_WEIGHT_UP_FACTOR = 1.1;     // provider 恢复时 link_weight 上调系数
const MAX_RETRY_ATTEMPTS = 3;          // 单个任务最大尝试次数(含首次)
const INITIAL_LINK_WEIGHT = 100;       // provider 初始 link_weight
```

#### 与现有 API Key 负载均衡的关系

`model-router` 是**新的、横跨 Provider/Model 级别**的路由层，与已有的 `key-state-manager`（同 Provider 多 Key 负载均衡）是两个完全独立、不冲突的模块：

| 维度 | model-router | key-state-manager |
|------|--------------|-------------------|
| 粒度 | Provider / Model | Provider / API Key |
| 目的 | 多 Provider/Model 路由选择 | 同 Provider 多账号负载均衡 |
| 状态 | 内存，num_done/num_doing/link_weight | 内存，available/inFlight/completed |
| 持久化 | 无（热加载重置） | 无（除用量统计外） |
| 文档 | 本节 | `docs/multi_key_balancer_design.md` |

二者可在同一次请求中先后使用：先由 model-router 选定 provider/model，再由 key-state-manager 在该 provider 内部选择具体 API Key。

#### 状态查看

管理面板可通过 `GET /api/model-router` 端点获取当前 Model Router 状态快照（providerWeights + taskStats），用于调试权重收敛。

## 管理面板

访问 `http://127.0.0.1:8765`：

| 标签页 | 功能 |
|--------|------|
| Dashboard | 服务状态、运行时长、内存占用、在线 Provider、Mappings 概览 |
| Providers | 增删改查模型厂商，配置 API Key/Base URL/代理 |
| Model Mappings | 管理模型名 → Provider/Model 的映射规则 |
| Agents | 管理 Config Set 和 Working Mode 对应关系 |
| Prompts | 编辑话题分类提示词（即时生效，无需重启） |
| Usage | 按天/周/月/年查看各 Provider/Model 调用量和 Token 消耗图表 |
| Raw Config | 直接编辑完整 `config.json` |

所有修改即时写回 `config.json` 和内存配置，无需重启服务。直接编辑 `config.json` 并保存同样会被监听并立即生效，等价于网页端保存。

## 用量追踪

每次 API 调用的 Token 消耗自动记录，存储在 `data/usage/` 目录下，按日期分文件（`YYYY-MM-DD.json`）。记录内容包括：

- 每个 Provider/Model 的调用次数
- 输入/输出/缓存 Token 数量
- 每次 Working Mode 激活次数

管理面板 **Usage** 标签页提供时间范围筛选、聚合粒度切换和 Chart.js 可视化图表。API 端点为 `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&unit=day|week|month|year`。

## Token 与缓存优化

Claude 系列工具（Claude Code / Cowork）会向 API 发出两类对上游转发无益、反而消耗 Token 或破坏缓存的特殊请求与标头。cc2llm 在代理层自动识别并拦截，无需用户任何配置。

### 1. 防护性请求拦截

Claude Code 会定期发出"守护"请求（daemon request）以探测服务可用性或维护计费周期，其典型特征为 `max_tokens ≤ 10`、无 system prompt、单条简短 user 消息。这类请求只消耗输入 Token，不会产生有意义的输出。

cc2llm 检测到此类请求后直接以 `200` 状态码返回 `{"input_tokens": 0}`，将 Token 消耗降为零，同时不让 Claude Code 的探测循环报错。

### 2. Billing Header 清除

Claude 原生 API 会在 system prompt 和消息内容末尾注入 `x-anthropic-billing-header` 标头（以文本形式嵌入 content）。该标头每轮不同，会导致上游 Provider 的 Prompt Cache 命中失败——即使对话内容未变，上游服务也会因这段差异重新计算全部输入。

cc2llm 在转发请求前自动从 `system` 和 `messages[].content` 中剥离该标头，确保相同上下文在上游服务端产生一致的哈希，最大化缓存命中率。

## 内置工具翻译 (Tool Translator)

Claude Code / Codex / Gemini 三种 Copilot 客户端各自携带了不同格式的内置工具（`web_search`、`web_fetch` / `url_context`），直接转发到非原生的 Provider 上游时会出现格式不兼容。cc2llm 通过 `lib/tool-translator/` 模块在请求转发前完成一次**客户端 → 目标 Provider**的格式互译：

- **识别阶段**：根据 `copilotId`（`claude_code` / `openai_responses` / `openai_chat` / `gemini_wrapped`）和 `matchStrategies` 在请求 tools 中匹配出内置工具
- **翻译阶段**：按 `providerRender[providerName]` 渲染为该 Provider 接受的格式；找不到 provider 级规则时回落到 `defaultRender`
- **回落响应**：识别为内置工具的 tool_call 不再转发上游，cc2llm 直接以"该 Provider 不支持该能力"的占位结果回写客户端，保证多轮 tool_use 链路不断裂
- **call_id 映射**：`call-id-map.js` 维护 Anthropic / OpenAI / Gemini 三种 tool_call_id 命名空间的双向映射，避免协议互转后 ID 错位

翻译表配置在 `config/tool-translator.json`，支持热重载（修改保存即时生效）。可在该文件内扩展新的 copilot 或 Provider 渲染规则。


```
  Claude Code    Codex CLI    Gemini CLI
  (Anthropic)    (OpenAI)     (Gemini)
       │             │            │
       └─────────────┼────────────┘
                     │
                     ▼
             ┌──────────────┐     ┌──────────────┐
             │  Proxy Port  │     │  Admin Port  │
             │   :8764      │     │   :8765      │
             │  多协议识别  │     │              │
             └──────┬───────┘     └──────┬───────┘
                    │                    │
                    ▼                    ▼
             ┌──────────────┐     ┌──────────────┐
             │  Model Map   │     │  Web Panel   │
             │  + Route     │     │  + REST API  │
             └──────┬───────┘     └──────┬───────┘
                    │                    │
                    ▼                    ▼
             ┌──────────────────────────────────┐
             │           config.json            │
             │  providers / agents / mappings   │
             └──────────────────────────────────┘
                    │
                    ▼
             ┌──────────────────────────────────┐
             │        Provider Handlers         │
             │  anthropic / openai / gemini     │
             │  openai-native / gemini-native   │
             │            auto                  │
             └──────┬───────────────────────────┘
                    │              │
                    ▼              ▼
             ┌──────────────┐  ┌─────────────────┐
             │  Usage       │  │  Thinking       │
             │  Tracker     │  │  Store          │
             │  (data/usage)│  │  (in-memory)    │
             └──────────────┘  └─────────────────┘
                    │
                    ▼
                Upstream APIs
```

### 多协议请求流

```
请求到达 :8764
      │
      ▼
  URL 路径检测
  ├── /v1/chat/completions | /responses ──→ openai-native handler ──→ 转换 → 路由 → 响应
  ├── /v1beta/models/*:generateContent ──→ gemini-native handler ──→ 转换 → 路由 → 响应
  └── /v1/messages ──→ Anthropic handler ──→ 路由 → 响应
```

## API

### 代理端口（默认 8764）

| 方法 | 路径 | 客户端 | 说明 |
|------|------|--------|------|
| GET | `/` `/health` | 通用 | 健康检查（含 Provider 列表和 Mappings 数量） |
| GET | `/v1/models` `/codex/models` | 通用 | 模型列表（从 modelMapping 生成，Codex CLI 用 `/codex/models`） |
| POST | `/v1/messages` | Claude Code/Cowork | 消息接口（Anthropic 格式），自动映射并路由 |
| POST | `/v1/chat/completions` `/responses` | Codex CLI/App | 消息接口（OpenAI 格式，含新版 Responses API），自动映射并路由 |
| POST | `/v1beta/models/{model}:generateContent` | Gemini CLI | 消息接口（Gemini 格式），自动映射并路由 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini CLI | 流式接口（Gemini 格式） |
| OPTIONS | `*` | 通用 | CORS 预检 |

### 管理端口（默认 8765）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务状态（uptime、内存、Provider 数量） |
| GET | `/api/config` | 获取完整配置 |
| PUT | `/api/config` | 更新配置（合并写入） |
| GET | `/api/providers` | Provider 列表（API Key 脱敏） |
| POST | `/api/providers` | 新增 Provider |
| DELETE | `/api/providers/:name` | 删除 Provider |
| GET | `/api/mappings` | Model Mapping 列表 |
| POST | `/api/mappings` | 新增 Mapping |
| PUT | `/api/mappings/:index` | 更新 Mapping |
| DELETE | `/api/mappings/:index` | 删除 Mapping |
| GET | `/api/prompts` | Prompt 列表 |
| PUT | `/api/prompts/:name` | 更新 Prompt |
| GET | `/api/models` | 从所有 Provider API 动态拉取模型列表（经过滤），按 Provider 分组返回 |
| GET | `/api/usage?from=&to=&unit=` | 用量统计查询 |
| GET | `/api/key-states` | 各 Provider 全部 API Key 实时状态（可用性、并发数、完成数） |

## 目录结构

```
cc2llm/
├── index.js                  # 入口，启动双端口服务 + claude/codex/gemini/wui 子命令
├── config.json               # 运行时配置（不提交）
├── config.template.json      # 配置模板
├── config/
│   ├── model-filter.json     # 模型列表过滤规则（按 Provider 的正则排除列表）
│   └── tool-translator.json  # tool-translator 模块配置（copilots / providerRender / defaultRender）
├── package.json
├── LICENSE
├── README.md
├── lib/
│   ├── config.js             # 配置读写、maxTokens 三层解析、向后兼容迁移、文件变更热重载
│   ├── logger.js             # 日志（debug/info/warn/error 四级过滤）
│   ├── model-mapper.js       # 模型名前缀匹配映射
│   ├── proxy-server.js       # 代理服务（:8764），多协议识别与路由分发
│   ├── proxy-agent.js        # HTTP 代理（CONNECT 隧道，支持上级代理）
│   ├── session-store.js      # Auto Mode 会话状态、Mode 缓存
│   ├── classifier.js         # 话题分类器（三协议适配）
│   ├── error-detector.js     # 错误响应分类器：区分 Key 级错误（4XX / Body 内嵌）与 Provider 级错误（5XX）
│   ├── model-fetcher.js      # 模型列表拉取
│   ├── prompt-store.js       # Prompt 文件管理
│   ├── thinking-store.js     # Thinking 块内存存储
│   ├── usage-tracker.js      # 用量记录与查询
│   ├── key-state-manager.js  # 多 Key 加权负载均衡状态引擎（动态权重、故障感知、自愈）
│   ├── tool-translator/      # Copilot 内置工具翻译模块
│   │   ├── index.js          #   - 入口：translateTools / enableHotReload / collectBuiltinKeys
│   │   ├── call-id-map.js    #   - 跨协议 tool_call_id 映射（Anthropic ↔ OpenAI ↔ Gemini）
│   │   ├── recognizer.js     #   - 工具识别：按 copilotId 识别客户端内置工具
│   │   └── renderer.js       #   - 工具渲染：按 targetProvider 渲染为目标格式
│   ├── providers/
│   │   ├── anthropic-compat.js  # Anthropic 协议处理
│   │   ├── openai-compat.js     # OpenAI 协议处理与 Anthropic ↔ OpenAI 互转
│   │   ├── gemini.js            # Gemini 协议处理与 Anthropic ↔ Gemini 互转
│   │   └── auto.js              # 自动路由引擎
│   ├── handlers/
│   │   ├── openai-native.js     # OpenAI 原生请求处理器（Codex CLI/App，含 Responses API、input sanitize、工具翻译）
│   │   └── gemini-native.js     # Gemini 原生请求处理器（Gemini CLI 客户端）
│   └── admin/
│       ├── index.js          # 管理服务（:8765）
│       └── routes.js         # 管理 API 路由
├── frontend/
│   ├── index.html            # 管理面板（7 个标签页）
│   ├── app.js                # 面板逻辑（Chart.js 可视化）
│   └── style.css             # 面板样式
├── prompts/
│   ├── classifier.md         # 话题分类提示词
│   ├── classifier-system.md  # 分类器 System Prompt
│   └── classifier-prefix.md  # 分类前缀提示词（在最新 user 输入前注入）
├── data/
│   └── usage/                # 用量数据（YYYY-MM-DD.json）
├── logs/                     # 跨协议调试日志（请求/上游/响应/结果分阶段记录），每次启动自动清空
└── test/
    ├── test.js                  # 单元测试
    ├── test-end-to-end.js       # 端到端测试
    ├── test-tool-translator.js  # tool-translator 单元测试
    └── verify-tools-schema.js   # tools schema 校验脚本
```

## 模型列表与过滤

管理面板的 Providers 标签页支持从 Provider API 动态拉取可用模型列表（`GET /api/models`），按 Provider 分组返回经过滤后的 LLM 模型。为过滤掉 embedding、TTS、图像生成等非 LLM 模型，`model-filter.json` 按 Provider 配置正则排除规则：

```json
{
  "google": ["embedding", "\\bimagen\\b", "\\bveo\\b", "\\btts\\b", ...],
  "openrouter": ["embedding", "-image\\b", "dall-e", "moderation", ...],
  "openai": ["embedding", "\\btts\\b", "\\bwhisper\\b", "dall-e", "moderation", ...],
  "xai": ["imagine", "\\btts\\b", "\\bstt\\b", "\\bvoice\\b"],
  "deepseek": ["\\bjanus\\b"],
  "moonshot": ["kimi-audio", "\\baudio\\b"],
  "minimax": ["\\bspeech\\b", "image-01", "hailuo"]
}
```

过滤规则按 Provider 名称匹配，正则大小写不敏感。不在此文件中的 Provider 不做过滤。

## 许可

Apache License 2.0 — 详见 [LICENSE](LICENSE)
