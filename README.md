# CC2LLM

> - AUTHOR: [LostAbaddon](lostabaddon@gmail.com)
> - VERSION: 1.1.1

将 Claude Cowork / Claude Code 请求透明转发到多厂商 LLM 的桥接代理，支持自动话题分类、智能路由和 Web 管理面板。

## 功能

- **多厂商支持** — Anthropic、OpenAI、Gemini 三种协议兼容，覆盖 DeepSeek / Google / Moonshot / MiniMax / OpenRouter 等十余家厂商
- **自动模式（Auto Mode）** — 内置话题分类器，根据对话内容自动匹配最佳工作模式（编程 / 写作 / 研究 / 规划等），无需手动切换模型
- **跨协议转换** — Anthropic ↔ OpenAI ↔ Gemini 请求/响应格式自动互转，保留 streaming、tool use、thinking 等高级特性
- **用量追踪** — 按天/周/月/年统计各 Provider/Model 的调用次数和 Token 消耗，管理面板内置可视化图表
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
- 空字符串 `prefix` 作为兜底匹配（所有模型名都包含空前缀），通常放在数组末尾，也可以不设置
- 未匹配任何前缀 → 原样透传

### Auto Mode / Agents（智能路由）

当 `provider` 设为 `auto` 时，cc2llm 会使用内置的话题分类器自动选择合适的模型：

```
用户输入 → 话题分类器（classifier）→ 匹配 Working Mode → 路由到对应模型
```

`agents` 配置支持多套配置集（Config Set），每套定义 Working Mode 与模型的对应关系：

```json
"agents": {
  "defaults": {
    "default":          "deepseek/deepseek-v4-flash",
    "quick":            "google/gemini-3.5-flash",
    "chatAndDailyJob":  "moonshot/kimi-k2.5",
    "planMaking":       "google/gemini-3.1-pro-preview",
    "code":             "deepseek/deepseek-v4-pro",
    "writing":          "deepseek/deepseek-v4-pro",
    "academicResearch": "google/gemini-3.1-pro-preview"
  },
  "fast": {
    "default":  "deepseek/deepseek-v4-flash",
    "quick":    "deepseek/deepseek-v4-flash",
    "code":     "deepseek/deepseek-v4-pro"
  }
}
```

- `defaults` — 默认配置集，modelMapping 中 `target: "auto"` 时使用
- 命名配置集 — 在 modelMapping 中设置 `target` 为配置集名称（如 `"fast"`）即可切换整套模式映射
- `default` — 每个配置集内的兜底模式，分类器未命中时使用
- `quick` — 分类器自身使用的轻量模型（用于快速判断话题）。支持 Anthropic / OpenAI / Gemini 三种协议的 Provider
- 其余 key — 自定义工作模式，分类器根据对话内容自动匹配
- **数值支持数组**：当某个 mode 的值为数组时，每次命中随机选取一个 spec，用于负载分散

分类提示词可在管理面板的 **Prompts** 标签页实时编辑，或直接修改 `prompts/classifier.md`。

### Auto Mode 高级特性

- **Session 持久化** — 每个会话维护当前工作模式，非文本输入（tool call 结果等）自动延续当前 mode 不触发重新分类
- **Mode 缓存** — `modeCacheTtl` 秒内同一 session 的分类结果被缓存复用，减少延迟和成本
- **分类器多协议** — quick 模型可以是 Anthropic/OpenAI/Gemini 任一协议的 Provider，分类器自动适配请求格式
- **对话裁剪** — `conversationGroups` 控制送入分类器的最近对话组数，仅保留纯文本消息，去除 tool call 和 tool result

## 管理面板

访问 `http://127.0.0.1:8765`：

| 标签页 | 功能 |
|--------|------|
| Dashboard | 服务状态、运行时长、内存占用、在线 Provider、Mappings 概览 |
| Providers | 增删改查模型厂商，配置 API Key/Base URL/代理 |
| Model Mappings | 管理 Claude → 目标模型的映射规则 |
| Agents | 管理 Config Set 和 Working Mode → Provider/Model 的对应关系，设置 Mode Cache TTL 和对话裁剪参数 |
| Prompts | 编辑话题分类提示词（即时生效，无需重启） |
| Usage | 按天/周/月/年查看各 Provider/Model 调用量和 Token 消耗图表 |
| Raw Config | 直接编辑完整 `config.json` |

所有修改即时写回 `config.json` 和内存配置，无需重启服务。

## 用量追踪

cc2llm 自动记录每次 API 调用的 Token 消耗，数据存储在 `data/usage/` 目录下，按日期分文件（`YYYY-MM-DD.json`）。记录内容包括：

- 每个 Provider/Model 的调用次数
- 输入/输出/缓存 Token 数量
- 每次 Working Mode 激活次数

管理面板 **Usage** 标签页提供时间范围筛选、聚合粒度切换和 Chart.js 可视化图表。API 端点为 `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&unit=day|week|month|year`。

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

### Auto Mode 流程

```
用户消息 → 是否为文本输入？
              │
     ┌───────┴───────┐
     │ YES           │ NO
     ▼               ▼
  Mode 缓存命中?   保持当前 Mode
  │    │               │
  ├ YES → 复用缓存 Mode
  │
  └ NO ↓
  话题分类器(quick model)
     │
     ▼
  结果解析
  │    │
  ├ 新话题 + mode → 切换到对应 Agent
  ├ 新话题 - mode → 使用 default
  └ 非新话题 ──────→ 保持当前 Mode
        │
        ▼
  setSession(sessionKey, mode)
  recordModeActivation(mode)
        │
        ▼
  resolveAgent(mode, configSet)
    → provider + model
        │
        ▼
  转发到上游 API
  recordUsage(provider, model, tokens)
```

### Thinking 块持久化

Anthropic 协议中，当 assistant 消息包含 tool_use 时，API 可能不返回对应的 thinking 块。cc2llm 自动在响应流中捕获 thinking 块并存入内存（按 `tool_use_id` 索引），在下次请求时从请求体中检测缺失的 thinking 块并补回，确保 Claude Code 正确处理 tool use 相关的思考链。

### Cache Control 注入

对于 Anthropic 协议的 Provider，cc2llm 自动为请求中的 system prompt 和最后一条 user 消息的尾部 content block 注入 `cache_control: { type: "ephemeral" }` 标记，使上游支持 prompt caching 的 API 能正确识别断点。

## API

### 代理端口（默认 8764）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` `/health` | 健康检查（含 Provider 列表和 Mappings 数量） |
| GET | `/v1/models` | 模型列表（从 modelMapping 生成） |
| POST | `/v1/messages` | 消息接口（Anthropic 格式），自动映射模型并路由 |
| OPTIONS | `*` | CORS 预检 |

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
| GET | `/api/usage?from=&to=&unit=` | 用量统计查询 |

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
│   ├── config.js             # 配置读写、maxTokens 三层解析、向后兼容迁移
│   ├── logger.js             # 日志（debug/info/warn/error 四级过滤）
│   ├── proxy-server.js       # 代理服务（:8765），模型映射与路由分发
│   ├── proxy-agent.js        # HTTP 代理（CONNECT 隧道，支持上级代理）
│   ├── session-store.js      # Auto Mode 会话状态、Mode 缓存
│   ├── classifier.js         # 话题分类器（Anthropic/OpenAI/Gemini 三协议适配）
│   ├── prompt-store.js       # Prompt 文件管理（YAML frontmatter 解析）
│   ├── thinking-store.js     # Thinking 块内存存储（按 tool_use_id 索引）
│   ├── usage-tracker.js      # 用量记录与查询（按天分文件、聚合统计）
│   ├── providers/
│   │   ├── anthropic-compat.js  # Anthropic 协议处理（thinking 恢复、cache_control 注入）
│   │   ├── openai-compat.js     # OpenAI 协议处理与 Anthropic ↔ OpenAI 互转
│   │   ├── gemini.js            # Gemini 协议处理与 Anthropic ↔ Gemini 互转
│   │   └── auto.js              # 自动路由引擎（分类调度、config set 解析）
│   └── admin/
│       ├── index.js          # 管理服务（:8766），静态文件 + API 路由
│       └── routes.js         # 管理 API 路由
├── frontend/
│   ├── index.html            # 管理面板（7 个标签页）
│   ├── app.js                # 面板逻辑（Chart.js 可视化）
│   └── style.css             # 面板样式
├── prompts/
│   └── classifier.md         # 话题分类提示词（YAML frontmatter + Markdown body）
├── data/
│   └── usage/                # 用量数据（YYYY-MM-DD.json）
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
| 用量追踪 | 无 | 按天统计 + 可视化图表 |
| Thinking 处理 | 无 | 自动捕获/恢复 thinking 块 |
| Cache 优化 | 无 | 自动注入 cache_control 断点 |

## 许可

Apache License 2.0 — 详见 [LICENSE](LICENSE)
