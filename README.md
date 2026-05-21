<h1 align="center">Codex Bridge</h1>

<p align="center">
  macOS 原生菜单栏应用 —— 一键启动/管理 Codex 本地代理，
  可视化配置供应商、切换模型，实时查看运行日志。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/swift-5.9-F05138?logo=swift&logoColor=white" alt="Swift 5.9">
  <img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex Bridge 是一个 macOS 原生菜单栏应用，内置本地代理引擎（`proxy.mjs`），
让 [Codex CLI](https://github.com/openai/codex) 通过单一 `base_url` 访问 **DeepSeek**、**小米 MiMo**、**OpenAI** 等 20+ 主流大模型供应商。

## 截图

<!-- TODO: 添加截图 -->

## 特性

### 原生 macOS 菜单栏应用
- 纯 AppKit 实现，无 WebView/SwiftUI
- 菜单栏图标，一键启动/停止代理
- 快捷键 `Cmd+W` 开关仪表盘窗口
- 无 Dock 图标（`LSUIElement=true`）

### 可视化仪表盘
- 实时状态卡片：运行状态、端口、启用的供应商数
- 供应商管理面板：启用/禁用、切换模型、删除自定义供应商
- 彩色分级实时日志（按级别着色）
- 自动刷新（1 秒轮询）

### 供应商管理
- 内置 20 个主流供应商模板（OpenAI、DeepSeek、Gemini、Kimi、GLM、通义千问、百度千帆 等）
- 选择供应商自动填充名称、Base URL 和模型列表
- 支持自定义供应商
- 模型切换实时生效，自动保存并重启代理

### 代理引擎（proxy.mjs）
- 双向协议翻译：OpenAI Responses API ↔ Chat Completions（流式 SSE）
- 思考模式 / 工具调用多轮对话缓存
- 入站鉴权（`PROXY_AUTH_KEY` / `PROXY_KEYS`）
- 会话延续（`previous_response_id` 跨供应商）
- 内置 `web_fetch` 工具
- 零依赖单文件

## 快速开始

### 安装

**方式一：下载 App（推荐）**

从 [Releases](https://github.com/moseisipwe-droid/codex-bridge/releases) 下载最新版 `Codex Bridge.app`，拖入 `/Applications` 打开即可。

**方式二：从源码构建**

```bash
git clone https://github.com/moseisipwe-droid/codex-bridge.git
cd codex-bridge
./build.sh            # 产物在 build/Codex Bridge.app
open build/Codex\ Bridge.app
```

### 首次启动

1. **前提条件**：安装 [Node.js](https://nodejs.org) 18+
2. 打开 Codex Bridge → 菜单栏出现 🟡 图标
3. 首次运行会自动弹出配置引导，或手动编辑：
   ```bash
   # ~/.codex/codex-bridge/.env
   PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)
   DEEPSEEK_API_KEY=sk-...   # 你的 API Key
   ```
4. 点击菜单栏图标 → **启动代理**

### 配置 Codex CLI

```toml
# ~/.codex/config.toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

```json
// ~/.codex/auth.json
{ "OPENAI_API_KEY": "<同 .env 中的 PROXY_AUTH_KEY>" }
```

运行 `codex`，开始使用。

## 项目结构

```
codex-bridge/
├── main.swift                        # 应用入口
├── AppDelegate.swift                 # 菜单栏 + 状态管理
├── ProxyManager.swift                # 代理进程管理
├── DashboardWindowController.swift   # 仪表盘窗口
├── proxy.mjs                         # 代理引擎（零依赖）
├── Info.plist                        # 应用配置
├── build.sh                          # 构建脚本
├── package.json                      # Node.js 配置
├── env.example                       # 环境变量模板
├── AppIcon.iconset/                  # 应用图标
└── scripts/smoke.sh                  # 代理冒烟测试
```

## 构建

```bash
./build.sh
```

产物在 `build/Codex Bridge.app`。构建后可直接拖到 `/Applications`。

## 供应商模板

| 供应商 | 说明 |
|--------|------|
| OpenAI | GPT 系列 |
| DeepSeek | DeepSeek V4 |
| Claude | Anthropic Claude |
| Gemini | Google Gemini |
| Kimi | Moonshot AI |
| MiMo | 小米 MiMo |
| GLM | 智谱 GLM |
| 通义千问 | 阿里云 |
| 百度千帆 | 百度 |
| 火山引擎 | 字节跳动 |
| 讯飞星火 | 科大讯飞 |
| 腾讯混元 | 腾讯 |
| 百川 | 百川智能 |
| 零一万物 | Yi 系列 |
| 阶跃星辰 | Step 系列 |
| SiliconFlow | SiliconFlow |
| Groq | Groq |
| xAI | Grok |
| Perplexity | Perplexity |
| Together | Together AI |

## 配置

详见 [env.example](./env.example)。

## Troubleshooting

| 症状 | 原因 | 解决 |
|------|------|------|
| 代理无法启动 | Node.js 未安装 | `brew install node` |
| `EADDRINUSE :4000` | 端口被占用 | `lsof -ti:4000 \| xargs kill` 或改 `.env` 中的 `PROXY_PORT` |
| `401 Unauthorized` | 鉴权不匹配 | 检查 `auth.json` 与 `.env` 的密钥一致 |
| SSL 证书错误 | 缺少 CA 证书 | 在 `.env` 中设置 `NODE_EXTRA_CA_CERTS` |
| 模型无响应 | 供应商 API 密钥无效 | 检查仪表盘中的密钥状态 |

## License

MIT — 详见 [LICENSE](./LICENSE)。
