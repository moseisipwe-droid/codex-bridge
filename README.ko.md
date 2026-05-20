<h1 align="center">Codex Bridge</h1>

<p align="center">
  macOS 네이티브 메뉴바 앱 —
  Codex 로컬 프록시를 원클릭으로 시작/관리하고,
  공급자 구성, 모델 전환, 실시간 로그를 확인하세요.
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
  <strong>한국어</strong> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex Bridge는 macOS 네이티브 메뉴바 앱입니다. 내장 프록시 엔진을 통해
[Codex CLI](https://github.com/openai/codex)가 단일 `base_url`로
DeepSeek, Xiaomi MiMo, OpenAI 등 20+ 공급자에 접근할 수 있습니다.

## 기능

- 순수 AppKit 구현 (WebView / SwiftUI 미사용)
- 메뉴바 아이콘 — 원클릭 프록시 시작/중지
- 대시보드 윈도우 (`Cmd+W`) — 상태 카드, 공급자 관리, 실시간 로그
- 20개 공급자 템플릿 내장
- 커스텀 공급자 지원
- 모델 전환 시 자동 저장 및 재시작
- 프록시 엔진 (`proxy.mjs`) — Responses API ↔ Chat Completions 변환, 스트리밍 SSE

## 빠른 시작

```bash
git clone https://github.com/moseisipwe-droid/codex-bridge.git
cd codex-bridge
cp env.example .env
# .env 편집 (PROXY_AUTH_KEY, DEEPSEEK_API_KEY 등)
./build.sh
open Codex\ Bridge.app
```

Codex CLI 설정: `~/.codex/config.toml` 및 `~/.codex/auth.json` 편집.

## 빌드

```bash
./build.sh
```

결과물: `build/Codex Bridge.app`

## License

MIT — [LICENSE](./LICENSE) 참조.
