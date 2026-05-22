<h1 align="center">Codex Bridge</h1>

<p align="center">
  Aplicación nativa de macOS para la barra de menú —
  inicia y gestiona el proxy local de Codex con un clic,
  configura proveedores, cambia modelos y visualiza logs en tiempo real.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/swift-5.9-F05138?logo=swift&logoColor=white" alt="Swift 5.9">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <strong>Español</strong>
</p>

---

Codex Bridge es una aplicación nativa de macOS para la barra de menú.
Incluye un motor proxy integrado que permite a [Codex CLI](https://github.com/openai/codex)
acceder a **DeepSeek**, **Xiaomi MiMo**, **OpenAI** y más de 20 proveedores a través de un único `base_url`.

## Características

- AppKit puro, sin WebView ni SwiftUI
- Icono en la barra de menú — inicia/detiene el proxy con un clic
- Ventana de dashboard (`Cmd+W`) — tarjetas de estado, gestión de proveedores, logs en tiempo real
- 20 plantillas de proveedores integradas
- Soporte para proveedores personalizados
- Cambio de modelo con guardado y reinicio automáticos
- Motor proxy (`proxy.mjs`) — traducción Responses API ↔ Chat Completions, streaming SSE

## Inicio rápido

```bash
git clone https://github.com/moseisipwe-droid/codex-bridge.git
cd codex-bridge
cp env.example .env
# Edita .env (PROXY_AUTH_KEY, DEEPSEEK_API_KEY, etc.)
./build.sh
open Codex\ Bridge.app
```

Configura Codex CLI: edita `~/.codex/config.toml` y `~/.codex/auth.json`.

## Compilar

```bash
./build.sh
```

Producto: `build/Codex Bridge.app`

## Licencia

MIT — ver [LICENSE](./LICENSE).
