<div align="center">

# NervHub

[English](README.md) · **简体中文**

### 一个代理，所有客户端，任意后端。

将 Claude Code、Claude Cowork、Codex CLI、Codex App 和 Gemini CLI 透明桥接到任意 LLM 厂商——协议自动互译、话题感知路由、Web 面板即时生效。

开源 · 自托管 · Apache 2.0

[![Version](https://img.shields.io/badge/version-2.4.0-blue)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)](package.json)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

</div>

你挑了 AI 编程工具，也挑了 LLM 厂商。但它们之间讲的是不同的语言，切换厂商意味着打开 JSON、TOML 和 `.env` 文件一个一个地改——每个客户端都来一遍。NervHub 做的就是中间那层：一个轻量 Node.js 代理，用各客户端原生的协议收请求，自动翻译成上游厂商能懂的格式，再根据你正在做什么，把每条对话路由到最合适的模型。不用挨个改配置文件，不用重启终端，一个服务始终运行，改完即生效。

## 为什么是 NervHub

桥接 AI 编程工具和上游模型这件事，本质上只有两条路。

一条路是管配置。给你一个图形界面去操作配置文件，你在桌面应用里选好厂商，它帮你把 JSON、TOML 和环境变量写好，然后重启 CLI。这条路 **CC Switch** 走了，而且走得不错。

NervHub 选了另一条路。它不改配置文件，而是作为一个**常驻服务**跑在你的工具和网络之间。每一条 API 请求都实时经过它，所以它能翻译协议、识别话题类型、在多条 Key 之间分摊流量、在出问题时自动接管。改配置之后，下一个请求就生效，永远不用重启。

两条路根本就不是一回事：

| 关注点 | 管配置文件 | 管实时流量 |
|---|---|---|
| **管的是什么** | 硬盘上的静态文件 | 正在跑的网络请求 |
| **改完什么时候生效** | 重启客户端之后 | 下一条请求，立刻 |
| **协议差异怎么处理** | 各管各的，互不相干 | 一个服务统一收口，自动互译 |
| **谁来做路由决策** | 你手动选厂商 | 服务自动分类、匹配、兜底 |
| **出故障怎么处理** | 你发现、你打开应用、你手动切 | 服务自动检测、标记、隔离、恢复，全程不打断你 |
| **多条 Key 怎么用** | 不在这类工具的范畴内 | 加权随机分发 + 自动故障转移 + 恢复后自动召回 |
| **怎么看整体情况** | 各客户端分开看，甚至看不了 | 一个面板汇总所有客户端和厂商的数据 |

场景决定选择。如果你的用法是"一次配好不再动"，配置管理器够用。但如果你聊到一半想换模型、同一家厂商挂了多条 Key、需要 Key 挂了自动切备选、或者希望 Claude 和 Codex 统一走一个出口同时协议互译不出问题——这些场景下，静态配置编辑器就不够用了，运行时代理才是正解。

## 两条设计原则

NervHub 所有设计都扎根在两条原则上：

- **流量大于一切。** 代理绝不轻易丢弃它能处理的请求。某个 Key 挂了，池子里下一条健康的 Key 自动顶上。一个工具没法完美翻译，就生成占位响应保持对话继续。多轮工具调用链路，不会因为基础设施问题而中断。
- **配置永远热生效。** 用任意编辑器修改 `config.json` 保存即刻生效；打开 Web 面板改也一样。不用重启，不掉状态。你可以在工作途中添加一个新厂商，所有已连接的客户端不受任何影响。

## 快速开始

```bash
git clone https://github.com/LostAbaddon/NervHub.git
cd NervHub

# 复制模板并填入你的 API Key
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

## 功能一览

|  | 功能 | 说明 |
|:---:|---|---|
| 🔌 | **五个客户端，一个端口** | Claude Code、Claude Cowork、Codex CLI、Codex App、Gemini CLI 全部接到 `:8764`，URL 路径自动识别协议，无需分别配置 |
| 🌐 | **三种协议，任意厂商** | Anthropic Messages、OpenAI Chat/Responses、Google Gemini 三种原生协议，可转发到 DeepSeek、Google、Moonshot、MiniMax、OpenRouter 等任意兼容 API |
| 🔄 | **跨协议透明互译** | Claude 以为在跟 Anthropic 服务器对话，上游收到的却是标准 OpenAI 请求。streaming、tool call、thinking 块完整往返，双向无损 |
| 🧠 | **话题分类智能路由** | 轻量分类器读取对话内容，自动识别属于编程、研究、写作、规划哪种场景，匹配合适的模型，无需手动切换。分类提示词在面板里实时可编辑 |
| ⚖️ | **多 Key 负载均衡** | `apiKey` 支持数组，加权随机分发。自动识别 4XX 鉴权错误和 5XX 服务端错误，标记问题 Key 并隔离。Key 恢复后自动回到可用池 |
| 🛠️ | **内置工具翻译** | 自动识别 Claude、Codex、Gemini 各格式下的 `web_search` 和 `web_fetch` 工具，翻译成目标厂商格式。不兼容时回落为占位响应，确保多轮 tool_use 链路不断 |
| 📊 | **用量面板** | 按厂商和模型追踪调用次数与 Token 消耗，按天/周/月/年聚合，Chart.js 图表展示，浏览器里看全部 |
| ⚡ | **全局热加载** | 改 `config.json` 保存即生效，Web 面板同理。可以在中途添加新厂商，已连接的所有客户端不受影响 |
| 🎯 | **Token 与缓存优化** | 自动剥离会破坏上游 Prompt Cache 的计费标头，拦截 Claude 守护心跳请求避免无意义 Token 消耗 |
| 🔔 | **Git 更新提醒** | 每 30 分钟轮询远程 `master`/`develop` 分支，面板检测到更新时显示提醒横幅 |

## 客户端接入

NervHub 的代理端口（默认 `:8764`）同时接受三种原生 API 协议，根据 URL 路径自动识别。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8764
export ANTHROPIC_AUTH_TOKEN=nervhub
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude --dangerously-skip-permissions
```

一键启动：

```bash
npm start claude
```

### Claude Cowork

与 Claude Code 协议相同。将 Cowork 的 API 设置指向 `http://127.0.0.1:8764`，或设置同样的环境变量。

### Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8764/codex
export OPENAI_API_KEY=nervhub
codex
```

> `OPENAI_BASE_URL` 末尾的 `/codex` 是 Codex CLI 的硬性要求，NervHub 在路由时自动剥离。

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

设置 `OPENAI_API_KEY=nervhub` 后启动应用。Codex App 还需要一个模型目录文件，详见 `config.template.json` 中的注释。

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

一条请求的完整路径：

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
             └──────┬───────┘     └──────┬───────┘
                    │                    │
                    ▼                    ▼
             ┌──────────────┐     ┌──────────────┐
             │  模型映射     │     │  config.json │
             │  + 话题分类   │◄────│  （热加载）    │
             └──────┬───────┘     └──────────────┘
                    │
                    ▼
             ┌──────────────────────────────────┐
             │         厂商协议处理器             │
             │  anthropic / openai / gemini     │
             │  openai-native / gemini-native   │
             │            auto                  │
             └──────┬───────────────────────────┘
                    │
                    ▼
              上游 API 服务
        (DeepSeek / Google / Moonshot / ...)
```

每条请求按这个路径走：协议识别 → 模型名解析 → 可选话题分类 → Key 选择与负载均衡 → 协议翻译 → 上游转发 → 响应翻译 → 流式返回客户端。

## 配置

所有配置都在 `config.json` 中。直接编辑文件或通过 Web 面板（`:8765`）操作，都是热加载。

### Providers（模型厂商）

每个 Provider 代表一个模型服务商，支持三种协议类型：

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

`apiKey` 可以是字符串或数组（多 Key 负载均衡）。`type` 可选 `anthropic`、`openai`、`gemini` 或 `auto`。

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

按 `prefix` 长度降序匹配——`claude-opus-4-7` 先命中 `claude-opus` 而非更短的前缀。支持通配符，如 `gpt-*-mini`。

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
    "code":     { "description": "编写、修改、设计代码时选用", "models": "minimax/minimax-m3" },
    "research": { "description": "深度思考、头脑风暴、学术讨论时选用", "models": ["google/gemini-3.1-pro", "deepseek/deepseek-v4-pro"] }
  }
}
```

每个模式可以指定单个模型、加权数组，或附带 `description` 帮分类器识别场景。分类提示词在管理面板的 **Prompts** 标签页实时编辑。

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
| `GET` `/PUT` | `/api/prompts` | 分类提示词读写 |
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
├── lib/
│   ├── config.js              # 配置读写、热加载、maxTokens 解析
│   ├── model-mapper.js        # 前缀匹配模型路由
│   ├── proxy-server.js        # 代理服务 (:8764)——协议识别与分发
│   ├── classifier.js          # Auto Mode 话题分类器
│   ├── model-router.js        # 多模型加权路由 + 失败重试
│   ├── key-state-manager.js   # 多 Key 负载均衡 + 自愈
│   ├── usage-tracker.js       # Token 和调用统计
│   ├── update-checker.js      # Git 远程更新轮询
│   ├── tool-translator/       # 内置工具格式翻译
│   ├── providers/             # 协议处理器 (anthropic / openai / gemini / auto)
│   ├── handlers/              # 原生协议适配器 (openai-native / gemini-native)
│   └── admin/                 # 管理服务 (:8765) 和 REST API
├── frontend/                  # Web 面板 (HTML + vanilla JS + Chart.js)
├── prompts/                   # 分类提示词模板
├── config/                    # 工具翻译和模型过滤配置
├── data/usage/                # 用量日志 (YYYY-MM-DD.json)
└── test/                      # 测试套件
```

## License

[Apache License 2.0](LICENSE) © LostAbaddon
