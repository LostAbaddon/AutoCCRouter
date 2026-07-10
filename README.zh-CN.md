<div align="center">

# NervHub

[English](README.md) · **简体中文**

### 一个代理。所有客户端。任意后端。

将 Claude Code、Claude Cowork、Codex CLI、Codex App 和 Gemini CLI 透明桥接到任意 LLM 厂商——支持协议互译、话题感知的自动路由，以及实时 Web 面板。

开源 · 自托管 · Apache 2.0

[![Version](https://img.shields.io/badge/version-2.4.0-blue)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A518%20(recommended)-3c873a.svg)](package.json)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

</div>

你挑了 AI 编程工具。你挑了 LLM 厂商。但它们说的不是同一种语言，切换厂商意味着手工编辑 JSON、TOML 和 `.env` 文件——而且每个客户端各来一遍。**NervHub** 就是中间那一层：一个轻量的 Node.js 代理，用每个客户端各自的原生协议收请求，翻译成上游厂商期望的格式，再基于你正在做的事把每条对话路由到最合适的模型。不用逐个客户端改配置，不用重启终端。一个服务，常驻运行，热加载。

## 为什么是 NervHub

桥接 AI 编程工具和上游模型，本质上只有两条根本不同的路。

一条路——配置编辑器思路——给你一个管配置文件的图形界面。你在桌面应用里选好厂商，它把正确的 JSON、TOML 和环境变量写好，然后你重启 CLI。这条路 **CC Switch** 走了，而且走得不错。

NervHub 选了另一条路。它不编辑配置文件。它作为一个**常驻服务**跑在你的工具和网络之间。每一条 API 请求都实时经过它，所以它能翻译协议、分类对话、在多条 Key 之间分摊流量、在故障发生的当下作出反应。配置改动在下一条请求生效，而不是等下一次重启。

这种理念上的差异才是关键：

| 关注点 | 配置编辑器思路 | 运行时代理思路 |
|---|---|---|
| **管的是什么** | 硬盘上的静态文件 | 正在跑的 API 流量 |
| **改完什么时候生效** | 重启客户端之后 | 下一条请求，立刻 |
| **协议差异怎么处理** | 每个客户端的配置彼此隔离、互不相干 | 一个服务统一收口，所有协议归一 |
| **决策有多智能** | 你手动选厂商 | 服务自动分类、路由、兜底 |
| **出故障怎么处理** | 你发现、打开应用、手动切 | 服务自动检测、标记 Key、自愈、重试——无需人工介入 |
| **多条 Key 怎么用** | 不在范畴内 | 加权负载均衡 + 自动故障转移 + 恢复后自动召回 |
| **可观测性** | 各客户端分开看（能看就不错） | 跨所有客户端和厂商的统一面板 |

如果你的用法是"一次配好不再动"，配置管理器够用。但如果你聊到一半想换模型、同一家厂商挂了多条 Key、希望 Key 挂了能自动切备选、或者需要能保留 streaming、tool use 和 thinking 块的协议互译——这些场景下，静态配置编辑器就不够用了，运行时代理才是正解。

## 两条设计原则

NervHub 所有设计都扎根在两条原则上：

- **流量神圣不可弃。** 代理绝不丢弃一条它能处理的请求。某个 Key 被标记坏了，池子里下一条健康的 Key 自动接手流量。一个工具没法完美翻译，就生成占位响应保持对话继续。多轮对话链路，绝不会因为基础设施问题而中断。
- **配置永远热生效。** 用任意编辑器修改 `config.json`，或者改用 Web 面板——改动都会被检测到并在下一条请求生效。不用重启，不掉状态。你可以在工作途中改配置，而不打断任何已连接客户端的进行中工作。

## 快速开始

```bash
git clone https://github.com/LostAbaddon/NervHub.git
cd NervHub

# 复制模板并填入你的厂商 Key
cp config.template.json config.json

npm start          # 启动代理 (:8764) + 管理面板 (:8765)
npm start claude   # 启动代理后自动拉起 Claude Code
npm start codex    # 启动代理后自动拉起 Codex CLI
npm start gemini   # 启动代理后自动拉起 Gemini CLI
npm start wui      # 浏览器打开管理面板
```

| 服务 | 地址 |
|---|---|
| 代理端口（客户端接入） | `http://127.0.0.1:8764` |
| Web 管理面板 | `http://127.0.0.1:8765` |

默认端口从 `config.json` → `server.port`（8764）与 `server.adminPort`（8765）读取。文件缺失或这两个键未设置时，代理回退到 `:8765`，管理面板回退到 `:8766`。

## 功能一览

|  | 功能 | 说明 |
|:---:|---|---|
| 🔌 | **五个客户端，一个端口** | Claude Code、Claude Cowork、Codex CLI、Codex App、Gemini CLI 全部接到 `:8764`。URL 路径自动识别协议，无需分别配置 |
| 🌐 | **三种协议，任意厂商** | Anthropic Messages、OpenAI Chat/Responses、Google Gemini。可转发到 DeepSeek、Google、Moonshot/Kimi、MiniMax、OpenRouter、OpenAI 等任意兼容 API |
| 🧠 | **话题分类自动路由** | 轻量分类器读取对话，从可配置的模式集里挑出最佳工作模式（如 编程 / 写作 / 规划）。无需手动切模型。分类提示词在面板里实时可编辑 |
| 🔄 | **跨协议透明互译** | Claude 以为在跟 Anthropic 服务器对话，上游收到的却是标准 OpenAI 请求。streaming、tool call、thinking 块完整往返，双向无损 |
| ⚖️ | **多 Key 负载均衡** | `apiKey` 支持数组。加权随机分发，自动识别 4XX 鉴权错误和 5XX 服务端错误，Key 恢复后自愈回到可用池 |
| 🛠️ | **内置工具翻译** | 自动识别 Claude、Codex、Gemini 各原生格式下的内置工具（`web_search`、`web_fetch`、`url_context`、`googleSearch`、`urlContext`），渲染成目标厂商格式并去重同名冲突。不兼容时回落为占位响应，确保多轮 tool_use 链路不断 |
| 📊 | **用量面板** | 按厂商和模型追踪调用次数与 Token 消耗，按天/周/月/年聚合，Chart.js 图表展示，浏览器里看全部 |
| ⚡ | **全局热加载** | 改 `config.json` 保存即生效，Web 面板同理。可以在中途添加新厂商，已连接的所有客户端不受影响 |
| 🎯 | **Token 与缓存优化** | 自动剥离会破坏上游 Prompt Cache 的 `x-anthropic-billing-header` 标头块。在携带极小 `max_tokens` 的 token 计数探针（maybe）请求消耗 Token 前将其拦截 |
| 🔔 | **Git 更新提醒** | 每 30 分钟轮询远程 `master`/`develop` 分支，面板检测到新提交时显示提醒横幅 |

## 客户端接入

NervHub 的代理端口（默认 `:8764`）同时接受三种原生 API 协议，根据 URL 路径自动识别。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8764
export ANTHROPIC_AUTH_TOKEN=nervhub
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude --dangerously-skip-permissions --allow-dangerously-skip-permissions --settings '{"includeGitInstructions":false}'
```

一键启动：

```bash
npm start claude
```

> `npm start claude` 会以这些 flags 内嵌的方式跑同一条命令（参见 [index.js](index.js)）。

### Claude Cowork

与 Claude Code 协议相同。将 Cowork 的 API 设置指向 `http://127.0.0.1:8764`，或设置同样的环境变量。

### Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8764/codex
export OPENAI_API_KEY=nervhub
codex
```

> `OPENAI_BASE_URL` 末尾的 `/codex` 是 Codex CLI 的硬性要求。NervHub 通过 `/chat/completions` 与 `/responses` 路径识别 OpenAI 协议（不限定 base URL 前缀）；`/codex/...` 路径按原样转发到对应的原生适配器。

一键启动：

```bash
npm start codex
```

### Codex App（桌面版）

创建 `~/.codex/config.toml`：

```toml
model           = "deepseek-v4-pro"
model_provider  = "nervhub"
openai_base_url = "http://127.0.0.1:8764/codex"

[model_providers.nervhub]
name     = "NervHub Bridge"
base_url = "http://127.0.0.1:8764/codex"
wire_api = "chat"
env_key  = "OPENAI_API_KEY"
```

设置 `OPENAI_API_KEY=nervhub` 后启动应用。

### Gemini CLI

```bash
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8764
export GEMINI_API_KEY=nervhub
gemini
```

一键启动：

```bash
npm start gemini
```

### 多客户端同时使用

所有客户端共享同一套 Provider 配置、Model Mapping 和 Auto Mode 设置：

```bash
# 终端 1
npm start

# 终端 2
npm start claude

# 终端 3
npm start codex
```

## 架构

代理的请求处理流水线，从请求到响应：

```
  Claude Code    Codex CLI    Gemini CLI
  (Anthropic)    (OpenAI)     (Gemini)
       │             │            │
       └─────────────┼────────────┘
                     │
                     ▼
             ┌──────────────┐     ┌──────────────┐
             │  代理端口     │     │  管理端口      │
             │   :8764      │     │   :8765      │
             │  协议自动识别  │     │  Web 面板     │
             │              │     │  + REST API  │
             └──────┬───────┘     └──────┬───────┘
                    │                    │
                    ▼                    ▼
             ┌──────────────┐     ┌──────────────┐
             │  模型映射     │     │  config.json │
             │  + 话题分类   │◄────│  （热加载）    │
             └──────┬───────┘     └──────────────┘
                    │
                    ▼
             ┌──────────────────────────────┐
             │        auto 路由器            │  ◄── 仅当
             │   (lib/providers/auto)        │      provider = "auto"
             └─────────────┬────────────────┘
                           │ 解析出的模型
                           ▼
             ┌──────────────────────────────────┐
             │        上游适配器                 │
             │      (lib/providers/)            │
             │  anthropic / openai / gemini     │
             └──────┬───────────────────────────┘
                    │
                    ▼
              上游 API 服务
        (DeepSeek / Google / Moonshot / ...)

  并行地，`lib/handlers/` 中的客户端原生适配器
  (`openai-native`、`gemini-native`) 将 Codex 与 Gemini 的
  客户端协议翻译成上游适配器所需的请求体，并将响应翻译回去。
```

每条请求按这个路径走：协议识别 → 模型名解析 → 可选话题分类 → Key 选择与负载均衡 → 协议翻译 → 上游转发 → 响应翻译 → 流式返回客户端。

## 配置

所有配置都在 `config.json` 中。直接编辑文件或通过 Web 面板（`:8765`）操作，都是热加载。

### Providers

每个 Provider 代表一个模型厂商。`type` 字段选择上游协议适配器：

- `anthropic` — Anthropic Messages
- `openai` — OpenAI Chat / Responses
- `gemini` — Google Gemini
- `auto` — 路由器模式；该条目不包含连接信息，模型由 agent 分类器在每条请求上解析

```json
"deepseek": {
  "type": "anthropic",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.deepseek.com/anthropic",
  "models": [
    { "name": "deepseek-v4-pro", "maxTokens": 393216 }
  ]
}
```

`apiKey` 可以是字符串或数组（多 Key 负载均衡）。

### Model Mapping（模型名映射）

通过前缀匹配将客户端模型名路由到目标厂商：

```json
"modelMapping": [
  { "prefix": "claude-opus",  "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "gpt-5.4",      "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "gemini-2.5",   "target": "gemini-2.5-pro",   "provider": "google" },
  { "prefix": "auto",         "target": "auto",             "provider": "auto" }
]
```

规则排序为：字面前缀优先于通配符前缀；同组内，较长的前缀优先。所以 `claude-opus-4-7` 会先命中字面规则 `claude-opus` 而非更短的字面前缀，而像 `gpt-*-mini` 这样的通配符只在没有任何字面规则覆盖的形状上才生效。通配符将 `*` 编译为 `.*`（所以 `gpt-*-mini` 匹配 `^gpt-.*-mini`）。

### Auto Mode / Agents（智能路由）

当 `provider` 设为 `auto` 时，NervHub 对每条对话做话题分类，自动匹配最佳工作模式：

```
用户输入 → 话题分类器 → 工作模式匹配 → 路由到对应模型
```

```json
"agents": {
  "defaults": {
    "default":  "deepseek/deepseek-v4-pro",
    "quick":    "google/gemini-3.5-flash",
    "coding":   { "description": "编写、修改、设计代码时选用", "models": "minimax/minimax-m3" },
    "writing":  { "description": "撰写草案、报告或文档时选用",        "models": "deepseek/deepseek-v4-pro" },
    "planning": { "description": "制定或更新计划时选用",        "models": ["google/gemini-3.1-pro", "deepseek/deepseek-v4-pro"] }
  }
}
```

`default` 和 `quick` 是保留键——路由在分类失败时回退到 `default`，对短探针请求使用 `quick`。其他任何键都成为分类器可挑选的工作模式。

**多个 Agent 集合。** `agents` 是命名集合的映射（例如 `defaults`、`without-gemini`）。管理面板提供集合选择器，让你可以为每个环境保持一个配置，无需编辑 `config.json` 即可切换。分类提示词在 **Prompts** 标签页可实时编辑。

## API 参考

### 代理端口（`:8764`）

| 方法 | 路径 | 客户端 | 用途 |
|---|---|---|---|
| `GET` | `/` `/health` | 通用 | 健康检查 |
| `GET` | `/v1/models` `/codex/models` | 通用 | 模型列表 |
| `POST` | `/v1/messages` | Claude Code/Cowork | Anthropic Messages |
| `POST` | `/v1/chat/completions` `/responses` | Codex CLI/App | OpenAI Chat & Responses |
| `POST` | `/v1beta/models/{model}:generateContent` | Gemini CLI | Gemini 生成 |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Gemini CLI | Gemini 流式 |

### 管理端口（`:8765`）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/status` | 运行时长、内存、Provider 数量 |
| `GET` `/PUT` | `/api/config` | 读取/更新完整配置 |
| `GET` `/POST` `/DELETE` | `/api/providers` | 厂商增删改查 |
| `GET` `/POST` `/PUT` `/DELETE` | `/api/mappings` | 模型映射增删改查 |
| `GET` | `/api/prompts` | 列出分类提示词 |
| `PUT` | `/api/prompts/{name}` | 更新单个分类提示词 |
| `GET` | `/api/models` | 从各厂商 API 实时拉取模型列表 |
| `GET` | `/api/usage?from=&to=&unit=` | 用量统计 |
| `GET` | `/api/key-states` | 各 Key 可用性和负载状态 |
| `GET` | `/api/git-status` | Git 远程更新状态 |

## 管理面板

浏览器打开 `http://127.0.0.1:8765`：

| 标签页 | 功能 |
|---|---|
| **Dashboard** | 服务状态、运行时长、内存占用、Provider 概览、Git 更新提醒 |
| **Providers** | 增删改查模型厂商，配 API Key / Base URL / 代理 |
| **Model Mappings** | 管理前缀路由规则 |
| **Agents** | 配置工作模式和模型对应关系 |
| **Prompts** | 编辑分类提示词，保存即时生效 |
| **Usage** | 按时间和聚合粒度查看调用量与 Token 消耗图表 |
| **Raw Config** | 直接编辑 `config.json` |

## 目录结构

```
NervHub/
├── index.js                   # 入口——双端口服务 + 子命令
├── config.json                # 运行时配置（热加载）
├── config.template.json       # 配置模板
├── lib/                       # 服务代码
│   ├── config.js              # 配置读写、热加载、maxTokens 解析
│   ├── proxy-server.js        # 代理服务 (:8764)——协议识别与分发
│   ├── providers/             # 上游协议适配器 (anthropic / openai / gemini / auto 路由)
│   ├── handlers/              # 客户端原生适配器 (openai-native / gemini-native)
│   ├── tool-translator/       # 内置工具格式翻译
│   ├── key-state-manager.js   # 多 Key 负载均衡 + 自愈
│   ├── model-mapper.js        # 前缀匹配模型路由（字面 + 通配符）
│   ├── model-router.js        # 多模型加权路由 + 失败重试
│   ├── model-fetcher.js       # 从厂商 API 实时拉取模型列表
│   ├── classifier.js          # 话题分类提示词构造器
│   ├── prompt-store.js        # 分类提示词——fs.watch 热加载
│   ├── usage-tracker.js       # Token 和调用统计
│   ├── session-store.js       # 每会话状态
│   ├── thinking-store.js      # 工具调用 / thinking 块缓存
│   ├── proxy-agent.js         # 上游 HTTPS 请求助手
│   ├── error-detector.js      # 上游错误分类
│   ├── update-checker.js      # Git 远程更新轮询
│   ├── logger.js              # 日志 + 每交互阶段日志
│   ├── core.js                # 共享工具函数
│   └── admin/                 # 管理服务 (:8765) 与 REST API 路由
├── frontend/                  # Web 面板 (HTML + vanilla JS + Chart.js)
├── prompts/                   # 分类提示词模板
├── config/                    # 工具翻译和模型过滤配置
├── data/usage/                # 用量日志 (YYYY-MM-DD.json)
└── test/                      # 测试套件
```

## License

[Apache License 2.0](LICENSE) © LostAbaddon
