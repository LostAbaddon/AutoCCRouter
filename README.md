# CC2LLM

> - AUTHOR: [LostAbaddon](lostabaddon@gmail.com)
> - VERSION: 1.0.0

将 Claude Cowork / Claude Code 请求透明转发到多厂商 LLM 的桥接代理，支持自动话题分类、智能路由和 Web 管理面板。

## 功能

- **多厂商支持** — Anthropic、OpenAI、Gemini 三种协议兼容，覆盖 DeepSeek / Google / Moonshot / MiniMax / OpenRouter 等十余家厂商
- **自动模式（Auto Mode）** — 内置话题分类器，根据对话内容自动匹配最佳工作模式（编程 / 写作 / 研究 / 规划等），无需手动切换模型
- **跨协议转换** — Anthropic ↔ OpenAI ↔ Gemini 请求/响应格式自动互转，保留 streaming、tool use、thinking 等高级特性
- **Web 管理面板** — 可视化编辑 Provider、Model Mapping、Agent（Working Mode）、Prompt，无需重启服务即时生效

## 快速开始

```bash
git clone git@github.com:LostAbaddon/cc2llm.git
cd cc2llm

# 复制并填写配置
cp config.template.json config.json
# 编辑 config.json，填入各厂商 API Key

npm start
```

- 代理服务：`http://127.0.0.1:8764`（Claude Code / Cowork 配置此地址）
- 管理面板：`http://127.0.0.1:8765`

### Claude Code 接入

在 Claude Code 设置中将 API Base URL 指向 cc2llm：

```json
{
  "apiBaseUrl": "http://127.0.0.1:8764",
  "apiKey": "any-value"
}
```

或使用如下命令行命令：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8764
export ANTHROPIC_AUTH_TOKEN=cc2llm
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
export CLAUDE_YOLO=1
claude --dangerously-skip-permissions --allow-dangerously-skip-permissions --exclude-dynamic-system-prompt-sections --settings '{"includeGitInstructions":false}'
```

## 配置

`config.json` 结构：

```json
{
  "server": { "port": 8764, "host": "127.0.0.1", "adminPort": 8765 },
  "defaultMaxTokens": 131072,
  "providers": { ... },
  "agents": { ... },
  "modelMapping": [ ... ],
  "logLevel": "info"
}
```

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

### Model Mapping（模型名映射）

将 Claude 模型名按前缀匹配路由到目标厂商：

```json
"modelMapping": [
  { "prefix": "claude-opus",  "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "claude-sonnet", "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "claude-haiku",  "target": "deepseek-v4-flash", "provider": "deepseek" },
  { "prefix": "auto",          "target": "auto",             "provider": "auto" }
]
```

匹配规则：
- 按 `prefix` 长度降序排列，优先命中更具体的前缀
- `claude-opus-4-7-20250805` → `deepseek-v4-pro`（前缀 `claude-opus` 命中第一条）
- 未匹配任何前缀 → 原样透传

### Auto Mode / Agents（智能路由）

当 `provider` 设为 `auto` 时，cc2llm 会使用内置的话题分类器自动选择合适的模型：

```
用户输入 → 话题分类器（classifier）→ 匹配 Working Mode → 路由到对应模型
```

`agents` 配置定义 Working Mode 与模型的对应关系：

```json
"agents": {
  "default":    "deepseek/deepseek-v4-pro",
  "quick":      "google/gemini-3.5-flash",
  "chat":       "moonshot/kimi-k2.5",
  "coding":     "deepseek/deepseek-v4-pro",
  "writing":    "deepseek/deepseek-v4-flash",
  "research":   "google/gemini-3.1-pro-preview"
}
```

- `default` — 兜底模式，分类器未命中时使用
- `quick` — 分类器自身使用的轻量模型（用于快速判断话题）
- 其余 key — 自定义工作模式，分类器根据对话内容自动匹配

分类提示词可在管理面板的 **Prompts** 标签页实时编辑，或直接修改 `prompts/classifier.md`。

## 管理面板

访问 `http://127.0.0.1:8765`：

| 标签页 | 功能 |
|--------|------|
| Dashboard | 服务状态、在线 Provider、映射概览 |
| Providers | 增删改查模型厂商，配置 API Key/Base URL/代理 |
| Model Mappings | 管理 Claude → 目标模型的映射规则 |
| Agents | 管理 Working Mode → Provider/Model 的对应关系 |
| Prompts | 编辑话题分类提示词（即时生效，无需重启） |
| Raw Config | 直接编辑完整 `config.json` |

所有修改即时写回 `config.json` 和内存配置，无需重启服务。

## 架构

```
Claude Code / Cowork
        │
        ▼
┌──────────────┐     ┌──────────────┐
│  Proxy Port  │     │  Admin Port  │
│   :8764      │     │   :8765      │
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
│            auto                  │
└──────┬───────────────────────────┘
       │
       ▼
   Upstream APIs
```

### Auto Mode 流程

```
用户消息 → 是否为文本输入？
              │
     ┌───────┴───────┐
     │ YES           │ NO
     ▼               ▼
 话题分类器      保持当前 Mode
     │               │
     ▼               │
 新话题？            │
  │    │             │
  │    ├─ YES + mode → 切换到对应 Agent
  │    ├─ YES - mode → 使用 default
  │    └─ NO ────────→ 保持当前 Mode
  │                      │
  └──────────────────────┘
              │
              ▼
      resolveAgent(mode)
        → provider + model
              │
              ▼
      转发到上游 API
```

## API

### 代理端口（默认 8764）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` `/health` | 健康检查 |
| GET | `/v1/models` | 模型列表（从 modelMapping 生成） |
| POST | `/v1/messages` | 消息接口（Anthropic 格式） |
| OPTIONS | `*` | CORS 预检 |

### 管理端口（默认 8765）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务状态 |
| GET | `/api/config` | 获取完整配置 |
| PUT | `/api/config` | 更新配置 |
| GET | `/api/providers` | Provider 列表（脱敏） |
| POST | `/api/providers` | 新增 Provider |
| DELETE | `/api/providers/:name` | 删除 Provider |
| GET | `/api/mappings` | Model Mapping 列表 |
| POST | `/api/mappings` | 新增 Mapping |
| PUT | `/api/mappings/:index` | 更新 Mapping |
| DELETE | `/api/mappings/:index` | 删除 Mapping |
| GET | `/api/prompts` | Prompt 列表 |
| PUT | `/api/prompts/:name` | 更新 Prompt |

## 目录结构

```
cc2llm/
├── index.js                  # 入口，启动双端口服务
├── config.json               # 运行时配置（不提交）
├── config.template.json      # 配置模板
├── package.json
├── LICENSE
├── README.md
├── lib/
│   ├── config.js             # 配置读写
│   ├── logger.js             # 日志
│   ├── proxy-server.js       # 代理服务（:8764）
│   ├── proxy-agent.js        # HTTP 代理（支持上级代理）
│   ├── session-store.js      # Auto Mode 会话状态
│   ├── classifier.js         # 话题分类器
│   ├── prompt-store.js       # Prompt 文件管理
│   ├── thinking-store.js     # Thinking 签名存储
│   ├── providers/
│   │   ├── anthropic-compat.js  # Anthropic 协议处理
│   │   ├── openai-compat.js     # OpenAI 协议处理与互转
│   │   ├── gemini.js            # Gemini 协议处理与互转
│   │   └── auto.js              # 自动路由引擎
│   └── admin/
│       ├── index.js          # 管理服务（:8765）
│       └── routes.js         # 管理 API 路由
├── frontend/
│   ├── index.html            # 管理面板
│   ├── app.js                # 面板逻辑
│   └── style.css             # 面板样式
├── prompts/
│   └── classifier.md         # 话题分类提示词
└── test/
    └── test.js
```

## 与 cc2deepseek 的关系

cc2llm 是 cc2deepseek 的演进版本，从"单厂商一对一转发"升级为"多厂商智能路由"：

| 维度 | cc2deepseek | cc2llm |
|------|------------|--------|
| 厂商数 | 1（DeepSeek） | 无限制 |
| 协议 | Anthropic 透传 | 三种协议互转 |
| 路由 | 固定前缀映射 | 固定映射 + AI 话题分类 |
| 管理 | 无 | Web 管理面板 |
| Prompt | 硬编码 | 文件化管理 + 在线编辑 |

## 许可

Apache License 2.0 — 详见 [LICENSE](LICENSE)
