<div align="center">

# NervHub

**English** · [简体中文](README.zh-CN.md)

### One proxy. Every client. Any backend.

Transparently bridge Claude Code, Claude Cowork, Codex CLI, Codex App, and Gemini CLI to any LLM provider — with protocol translation, topic-aware auto-routing, and a live web dashboard.

Open-source · self-hosted · Apache 2.0

[![Version](https://img.shields.io/badge/version-2.4.0-blue)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A518%20(recommended)-3c873a.svg)](package.json)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

</div>

You pick your AI coding tool. You pick your LLM provider. They don't speak the same language, and switching providers means editing JSON, TOML, and `.env` files by hand — once per client. **NervHub** is the layer in between: a lightweight Node.js proxy that accepts requests in each client's native protocol, translates them to whatever your upstream provider expects, and routes every conversation to the best model based on what you're actually doing. No per-client config editing. No restarting terminals. One service, always on, hot-reloaded.

## Why NervHub

There are two fundamentally different ways to bridge AI coding tools and upstream models.

One approach — the config-editor approach — gives you a GUI over configuration files. You pick a provider in a desktop app, it writes the right JSON, TOML, and environment variables, and you restart your CLI. This is what **CC Switch** does, and it does it well.

NervHub takes the other path. It doesn't edit config files. It runs as a **persistent service** that lives between your tools and the network. Every API request passes through it — in real time — so it can translate protocols, classify conversations, balance load across API keys, and react to failures as they happen. Configuration changes take effect on the next request, not the next restart.

The philosophical difference matters:

| Concern | Config-Editor Approach | Runtime-Proxy Approach |
|---|---|---|
| **What it manages** | Static files on disk | Live API traffic |
| **When changes apply** | After client restart | Next request, instantly |
| **Protocol differences** | Each tool's config is insulated from the others | One service normalizes all protocols |
| **Decision intelligence** | User picks a provider manually | Service classifies, routes, and falls back automatically |
| **Failure handling** | User notices, opens app, switches manually | Service detects, marks keys, heals, retries — no human in the loop |
| **Multi-key usage** | Not in scope | Weighted load balancing with automatic failover and recovery |
| **Observability** | Per-client, if at all | Centralized dashboard across all clients and providers |

If your workflow is "set up once and forget it," a config manager is fine. If you switch models mid-session, keep multiple API keys per provider, want automatic fallback when a key goes down, or need protocol translation that preserves streaming, tool use, and thinking blocks — that's when a static config editor stops being enough and a runtime proxy becomes the right tool.

## Two design rules

Everything in NervHub hangs off two principles:

- **Traffic is sacred.** The proxy never drops a request it could have served. If a provider key is marked bad, the next healthy key in the pool gets the traffic. If a tool can't be translated, a placeholder response keeps the conversation going. Multi-turn chat chains never break because of infrastructure.
- **Configuration is always hot.** Edit `config.json` with any editor, or use the web dashboard — changes are detected and applied on the next request. No restart. No state loss. You can reconfigure a running session without interrupting work across any connected client.

## Quick Start

```bash
git clone https://github.com/LostAbaddon/NervHub.git
cd NervHub

# Copy and fill in your provider keys
cp config.template.json config.json

npm start          # Start proxy (:8764) + dashboard (:8765)
npm start claude   # Start proxy, then auto-launch Claude Code
npm start codex    # Start proxy, then auto-launch Codex CLI
npm start gemini   # Start proxy, then auto-launch Gemini CLI
npm start wui      # Open the dashboard in your browser
```

| Service | URL |
|---|---|
| Proxy (for clients) | `http://127.0.0.1:8764` |
| Web Dashboard | `http://127.0.0.1:8765` |

Defaults are read from `config.json` → `server.port` (8764) and `server.adminPort` (8765). When the file is missing or the keys are unset, the proxy falls back to `:8765` and the admin to `:8766`.

## What You Get

|  | Feature | Detail |
|:---:|---|---|
| 🔌 | **Five clients, one port** | Claude Code, Claude Cowork, Codex CLI, Codex App, and Gemini CLI all connect to `:8764`. Protocol auto-detection by URL path — no per-client configuration. |
| 🌐 | **Three protocols, any vendor** | Anthropic Messages, OpenAI Chat/Responses, and Google Gemini. Forward to DeepSeek, Google, Moonshot/Kimi, MiniMax, OpenRouter, OpenAI, or any compatible API. |
| 🧠 | **Auto mode with topic classification** | A lightweight classifier reads the conversation and picks the best working mode from a configurable set (e.g. coding / writing / planning). No manual model switching. Classification prompts are editable live in the dashboard. |
| 🔄 | **Cross-protocol translation** | Claude thinks it's talking to Anthropic; the upstream sees OpenAI. Streaming, tool calls, and thinking blocks survive the round-trip intact — in both directions. |
| ⚖️ | **Multi-key load balancing** | `apiKey` accepts an array. Weighted random distribution with automatic failure detection (4XX auth errors, 5XX server errors) and self-healing when keys recover. |
| 🛠️ | **Built-in tool translator** | Recognizes built-in tools (`web_search`, `web_fetch`, `url_context`, `googleSearch`, `urlContext`) in Claude, Codex, and Gemini native formats. Renders them in the target provider's format, deduplicating any name collisions. Falls back to placeholder responses so multi-turn tool chains never break. |
| 📊 | **Usage dashboard** | Track calls and token consumption by provider and model, aggregated by day, week, month, or year. Chart.js visualizations, all in the browser. |
| ⚡ | **Hot-reload everything** | Edit `config.json` with any editor — changes take effect on the next request. Or use the web dashboard; same effect, no restart. You can add a new provider mid-session without disrupting work in any connected client. |
| 🎯 | **Token and cache optimization** | Strips `x-anthropic-billing-header` blocks that break upstream prompt caching. Intercepts Claude Code's token-count probe (maybe) requests (those carrying an extremely small `max_tokens`) before they consume tokens. |
| 🔔 | **Git update notifier** | Polls remote `master`/`develop` every 30 minutes. Dashboard shows an update banner when new commits are available. |

## Client Setup

NervHub accepts three native API protocols on a single proxy port (`:8764` by default). The protocol is auto-detected from the URL path.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8764
export ANTHROPIC_AUTH_TOKEN=nervhub
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude --dangerously-skip-permissions --allow-dangerously-skip-permissions --settings '{"includeGitInstructions":false}'
```

One-command launch:

```bash
npm start claude
```

> `npm start claude` runs the same command with these flags baked in (see [index.js](index.js)).

### Claude Cowork

Same protocol as Claude Code. Point Cowork's API settings to `http://127.0.0.1:8764` or set the same environment variables.

### Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8764/codex
export OPENAI_API_KEY=nervhub
codex
```

> The trailing `/codex` is required by Codex CLI. NervHub identifies the OpenAI protocol by the `/chat/completions` and `/responses` paths under any base URL prefix; `/codex/...` is forwarded as-is to the matching native adapter.

One-command launch:

```bash
npm start codex
```

### Codex App (Desktop)

Create `~/.codex/config.toml`:

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

Set `OPENAI_API_KEY=nervhub` and launch the app.

### Gemini CLI

```bash
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8764
export GEMINI_API_KEY=nervhub
gemini
```

One-command launch:

```bash
npm start gemini
```

### Multi-Client Simultaneous Use

All clients share the same provider configs, model mappings, and auto-mode settings. Start them in separate terminals:

```bash
# Terminal 1
npm start

# Terminal 2
npm start claude

# Terminal 3
npm start codex
```

## Architecture

The proxy pipeline, from request to response:

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
             │  Protocol    │     │  Web Panel   │
             │  Detection   │     │  + REST API  │
             └──────┬───────┘     └──────┬───────┘
                    │                    │
                    ▼                    ▼
             ┌──────────────┐     ┌──────────────┐
             │  Model Map   │     │ config.json  │
             │  + Classify  │◄────│ (hot-reload) │
             └──────┬───────┘     └──────────────┘
                    │
                    ▼
             ┌──────────────────────────────┐
             │        auto router           │  ◄── only when
             │   (lib/providers/auto)       │      provider = "auto"
             └─────────────┬────────────────┘
                           │ resolved model
                           ▼
             ┌──────────────────────────────────┐
             │     Upstream Adapters            │
             │      (lib/providers/)            │
             │  anthropic / openai / gemini     │
             └──────┬───────────────────────────┘
                    │
                    ▼
                Upstream APIs
        (DeepSeek / Google / Moonshot / ...)

  In parallel, the client-side native adapters in `lib/handlers/`
  (`openai-native`, `gemini-native`) translate Codex and Gemini
  client protocols into the upstream adapters' request bodies
  and convert the responses back.
```

Every request follows this path: protocol detection → model name resolution → optional topic classification → key selection with load balancing → protocol translation → upstream dispatch → response translation → streaming back to the client.

## Configuration

Everything lives in `config.json`. Edit it directly or use the web dashboard at `:8765` — both are hot-reloaded.

### Providers

Each provider represents a model vendor. The `type` field selects the upstream protocol adapter:

- `anthropic` — Anthropic Messages
- `openai` — OpenAI Chat / Responses
- `gemini` — Google Gemini
- `auto` — router mode; the entry holds no connection info, the model is resolved by the agent classifier for each request

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

`apiKey` accepts either a string or an array for multi-key load balancing.

### Model Mapping

Routes client model names to target providers by prefix matching:

```json
"modelMapping": [
  { "prefix": "claude-opus",  "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "gpt-5.4",      "target": "deepseek-v4-pro",  "provider": "deepseek" },
  { "prefix": "gemini-2.5",   "target": "gemini-2.5-pro",   "provider": "google" },
  { "prefix": "auto",         "target": "auto",             "provider": "auto" }
]
```

Rules are sorted: literal prefixes win over wildcard prefixes; within each group, longer prefixes win. So `claude-opus-4-7` matches the literal rule `claude-opus` before any shorter literal, and a wildcard like `gpt-*-mini` only fires for shapes no literal rule covers. Wildcards compile `*` to `.*` (so `gpt-*-mini` matches `^gpt-.*-mini`).

### Auto Mode (Agents)

When a `modelMapping` rule has `provider: "auto"`, NervHub classifies the conversation and picks the best working mode:

```
User input → Classifier → Working Mode → Routed to model
```

Each working mode is a key in `config.agents.<set>`. A mode can be a single model spec (`"provider/model"`), a weighted array, or an object with a `description` used by the classifier:

```json
"agents": {
  "defaults": {
    "default":  "deepseek/deepseek-v4-pro",
    "quick":    "google/gemini-3.5-flash",
    "coding":   { "description": "Writing, editing, or designing code", "models": "minimax/minimax-m3" },
    "writing":  { "description": "Drafts, reports, literary work",        "models": "deepseek/deepseek-v4-pro" },
    "planning": { "description": "Specifying or updating a plan",        "models": ["google/gemini-3.1-pro", "deepseek/deepseek-v4-pro"] }
  }
}
```

`default` and `quick` are reserved — the router falls back to `default` when classification fails and uses `quick` for short probe requests. Any other key becomes a working mode the classifier can pick.

**Multiple agent sets.** `agents` is a map of named sets (e.g. `defaults`, `without-gemini`). The dashboard exposes a set selector so you can keep one configuration per environment and switch without editing `config.json`. Classification prompts are live-editable in the **Prompts** tab.

## API Reference

### Proxy Port (`:8764`)

| Method | Path | Client | Purpose |
|---|---|---|---|
| `GET` | `/` `/health` | All | Health check |
| `GET` | `/v1/models` `/codex/models` | All | Model list |
| `POST` | `/v1/messages` | Claude Code/Cowork | Anthropic Messages |
| `POST` | `/v1/chat/completions` `/responses` | Codex CLI/App | OpenAI Chat & Responses |
| `POST` | `/v1beta/models/{model}:generateContent` | Gemini CLI | Gemini generate |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Gemini CLI | Gemini stream |

### Admin Port (`:8765`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/status` | Uptime, memory, provider count |
| `GET` `/PUT` | `/api/config` | Read/update full config |
| `GET` `/POST` `/DELETE` | `/api/providers` | CRUD providers |
| `GET` `/POST` `/PUT` `/DELETE` | `/api/mappings` | CRUD model mappings |
| `GET` | `/api/prompts` | List classifier prompts |
| `PUT` | `/api/prompts/{name}` | Update one classifier prompt |
| `GET` | `/api/models` | Live model list from provider APIs |
| `GET` | `/api/usage?from=&to=&unit=` | Usage statistics |
| `GET` | `/api/key-states` | Per-key availability and load |
| `GET` | `/api/git-status` | Remote update status |

## Dashboard

Open `http://127.0.0.1:8765` in any browser:

| Tab | What you can do |
|---|---|
| **Dashboard** | Service status, uptime, memory, provider overview, Git update banner |
| **Providers** | Add, edit, or remove model vendors — keys, base URLs, proxies |
| **Model Mappings** | Manage prefix-based routing rules |
| **Agents** | Configure working modes and model assignments |
| **Prompts** | Edit classifier prompts — takes effect immediately |
| **Usage** | Charts of calls and token consumption over time |
| **Raw Config** | Direct `config.json` editor |

## Project Structure

```
NervHub/
├── index.js                   # Entry point — dual-port server + sub-commands
├── config.json                # Runtime configuration (hot-reloaded)
├── config.template.json       # Configuration template
├── lib/                       # Service code
│   ├── config.js              # Config I/O, hot-reload, maxTokens resolution
│   ├── proxy-server.js        # Proxy service (:8764) — protocol detection and dispatch
│   ├── providers/             # Upstream protocol adapters (anthropic / openai / gemini / auto router)
│   ├── handlers/              # Client-side native adapters (openai-native / gemini-native)
│   ├── tool-translator/       # Built-in tool format translation
│   ├── key-state-manager.js   # Multi-key load balancing with self-healing
│   ├── model-mapper.js        # Prefix-based model name routing (literal + wildcard)
│   ├── model-router.js        # Weighted multi-model routing with failure retry
│   ├── model-fetcher.js       # Live model list from provider APIs
│   ├── classifier.js          # Topic classifier prompt builder
│   ├── prompt-store.js        # Classifier prompts — fs.watch hot reload
│   ├── usage-tracker.js       # Token and call statistics
│   ├── session-store.js       # Per-session state
│   ├── thinking-store.js      # Tool-use / thinking-block cache
│   ├── proxy-agent.js         # Upstream HTTPS request helper
│   ├── error-detector.js      # Upstream error classification
│   ├── update-checker.js      # Git remote update polling
│   ├── logger.js              # Logging + per-interaction stage log
│   ├── core.js                # Shared utilities
│   └── admin/                 # Admin service (:8765) and REST API routes
├── frontend/                  # Web dashboard (HTML + vanilla JS + Chart.js)
├── prompts/                   # Classifier prompt templates
├── config/                    # Tool translator and model filter configs
├── data/usage/                # Usage logs (YYYY-MM-DD.json)
└── test/                      # Test suite
```

## License

[Apache License 2.0](LICENSE) © LostAbaddon
