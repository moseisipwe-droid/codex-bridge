<h1 align="center">Codex Bridge</h1>

<p align="center">
  macOS ネイティブメニューバーアプリ —
  Codex ローカルプロキシを起動・管理し、
  プロバイダの可視化設定、モデル切り替え、リアルタイムログ表示を実現。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/swift-5.9-F05138?logo=swift&logoColor=white" alt="Swift 5.9">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <strong>日本語</strong> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex Bridge は macOS ネイティブのメニューバーアプリです。内蔵プロキシエンジンにより、
[Codex CLI](https://github.com/openai/codex) が単一の `base_url` で
DeepSeek、Xiaomi MiMo、OpenAI など 20+ のプロバイダにアクセス可能になります。

## 機能

- 純粋な AppKit 実装（WebView / SwiftUI 不使用）
- メニューバーアイコンからワンクリックでプロキシ起動/停止
- ダッシュボードウィンドウ（`Cmd+W`）— ステータスカード、プロバイダ管理、リアルタイムログ
- 20 のプロバイダテンプレート内蔵
- カスタムプロバイダ対応
- モデル切り替えは自動保存＆再起動
- プロキシエンジン（`proxy.mjs`）— Responses API ↔ Chat Completions 変換、ストリーミング SSE

## クイックスタート

```bash
git clone https://github.com/moseisipwe-droid/codex-bridge.git
cd codex-bridge
cp env.example .env
# .env を編集（PROXY_AUTH_KEY, DEEPSEEK_API_KEY 等）
./build.sh
open Codex\ Bridge.app
```

Codex CLI の設定：`~/.codex/config.toml` と `~/.codex/auth.json` を編集。

## ビルド

```bash
./build.sh
```

成果物：`build/Codex Bridge.app`

## License

MIT — [LICENSE](./LICENSE) 参照。
