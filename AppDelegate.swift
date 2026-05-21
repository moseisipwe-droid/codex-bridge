import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var toggleItem: NSMenuItem!
    private var windowItem: NSMenuItem!
    private let proxyManager = ProxyManager()
    private let dashboard = DashboardWindowController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🟡"

        let menu = NSMenu()
        windowItem = menu.addItem(withTitle: "显示窗口", action: #selector(toggleWindow), keyEquivalent: "w")
        windowItem.target = self
        menu.addItem(.separator())
        toggleItem = menu.addItem(withTitle: "启动代理", action: #selector(toggleProxy), keyEquivalent: "s")
        toggleItem.target = self
        menu.addItem(.separator())
        let envItem = menu.addItem(withTitle: "编辑 .env", action: #selector(openEnv), keyEquivalent: "e")
        envItem.target = self
        menu.addItem(.separator())
        let quitItem = menu.addItem(withTitle: "退出", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        statusItem.menu = menu

        proxyManager.onLogOutput = { print("[proxy]", $0) }
        if proxyManager.ensureResources() {
            proxyManager.start()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
                showSetupDialog()
            }
        }

        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        proxyManager.stop()
    }

    @objc private func toggleWindow() {
        if dashboard.window?.isVisible ?? false {
            dashboard.hideDashboard()
            windowItem.title = "显示窗口"
        } else {
            dashboard.showDashboard()
            windowItem.title = "隐藏窗口"
        }
    }

    @objc private func toggleProxy() {
        if proxyManager.isRunning {
            proxyManager.stop()
            toggleItem.title = "启动代理"
            statusItem.button?.title = "🔴"
        } else {
            proxyManager.start()
            toggleItem.title = "停止代理"
            statusItem.button?.title = "🟡"
        }
    }

    @objc private func openEnv() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/codex-bridge/.env")
        NSWorkspace.shared.open(dir)
    }

    @objc private func quitApp() {
        proxyManager.stop()
        NSApp.terminate(nil)
    }

    private func showSetupDialog() {
        let fw: CGFloat = 380
        let rowH: CGFloat = 26
        let pad: CGFloat = 8

        let authField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        authField.placeholderString = "PROXY_AUTH_KEY（留空自动生成）"
        authField.tag = 10

        let deepseekField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        deepseekField.placeholderString = "DeepSeek API Key（必填）"
        deepseekField.tag = 11

        let mimoField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        mimoField.placeholderString = "MiMo API Key（可选）"
        mimoField.tag = 12

        let openaiField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        openaiField.placeholderString = "OpenAI API Key（可选）"
        openaiField.tag = 13

        let hint = NSTextField(labelWithString: "需要至少填写一个 API Key。密钥仅保存在本地 ~/.codex/codex-bridge/.env")
        hint.font = NSFont.systemFont(ofSize: 11)
        hint.textColor = .secondaryLabelColor
        hint.frame = NSRect(x: 0, y: 0, width: fw, height: 16)

        let totalH: CGFloat = rowH + pad + rowH + pad + rowH + pad + rowH + 8 + 16 + 4
        let c = NSView(frame: NSRect(x: 0, y: 0, width: fw, height: totalH))
        c.autoresizingMask = []

        var y: CGFloat = totalH - rowH
        authField.frame.origin = NSPoint(x: 0, y: y)
        y -= pad + rowH
        deepseekField.frame.origin = NSPoint(x: 0, y: y)
        y -= pad + rowH
        mimoField.frame.origin = NSPoint(x: 0, y: y)
        y -= pad + rowH
        openaiField.frame.origin = NSPoint(x: 0, y: y)
        y -= 8 + 16
        hint.frame.origin = NSPoint(x: 0, y: y)

        c.addSubview(authField)
        c.addSubview(deepseekField)
        c.addSubview(mimoField)
        c.addSubview(openaiField)
        c.addSubview(hint)

        let alert = NSAlert()
        alert.messageText = "欢迎使用 Codex Bridge"
        alert.informativeText = "首次使用需要配置 API Key："
        alert.accessoryView = c
        alert.addButton(withTitle: "保存并启动")
        alert.addButton(withTitle: "稍后设置")

        let resp = alert.runModal()
        if resp == .alertFirstButtonReturn {
            let auth = authField.stringValue.trimmingCharacters(in: .whitespaces)
            let deepseek = deepseekField.stringValue.trimmingCharacters(in: .whitespaces)
            let mimo = mimoField.stringValue.trimmingCharacters(in: .whitespaces)
            let openai = openaiField.stringValue.trimmingCharacters(in: .whitespaces)
            saveConfig(auth: auth, deepseek: deepseek, mimo: mimo, openai: openai)
        }
    }

    private func saveConfig(auth: String, deepseek: String, mimo: String, openai: String) {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/codex-bridge")
        let envPath = dir.appendingPathComponent(".env")

        let authKey = auth.isEmpty ? "sk-proxy-local-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(48))" : auth
        var lines: [String] = []
        lines.append("# Codex Bridge — 自动生成")
        lines.append("PROXY_AUTH_KEY=\(authKey)")
            if !deepseek.isEmpty { lines.append("MY_DS_KEY=\(deepseek)") }
        if !mimo.isEmpty { lines.append("MIMO_API_KEY=\(mimo)") }
        if !openai.isEmpty { lines.append("OPENAI_API_KEY=\(openai)") }
        lines.append("DEEPSEEK_BASE_URL=https://api.deepseek.com/v1")
        lines.append("DEEPSEEK_MODELS=deepseek-chat,deepseek-v4-flash,deepseek-v4-pro,deepseek-reasoner")
        lines.append("DEFAULT_PROVIDER=deepseek")
        lines.append("")
        let content = lines.joined(separator: "\n")

        try? content.write(to: envPath, atomically: true, encoding: .utf8)
        // 同时写入 ~/.codex/auth.json，使 Codex CLI 能直接连接
        let authDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
        let authPath = authDir.appendingPathComponent("auth.json")
        try? FileManager.default.createDirectory(at: authDir, withIntermediateDirectories: true)
        let authContent = "{\n  \"auth_mode\": \"apikey\",\n  \"OPENAI_API_KEY\": \"\(authKey)\"\n}\n"
        try? authContent.write(to: authPath, atomically: true, encoding: .utf8)
        // 提示用户配置 config.toml
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let alert = NSAlert()
            alert.messageText = "配置完成"
            alert.informativeText = "已自动写入 .env 和 auth.json。\n\n如果还没配置 Codex CLI，请编辑 ~/.codex/config.toml：\n\n[model_providers.你的供应商]\nbase_url = \"http://127.0.0.1:4000/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true"
            alert.addButton(withTitle: "知道了")
            alert.runModal()
        }
        proxyManager.start()
    }

    private func checkHealth() {
        guard let url = URL(string: "http://127.0.0.1:4000/health") else { return }
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            DispatchQueue.main.async {
                if error == nil {
                    self?.statusItem.button?.title = "🟢"
                    self?.toggleItem?.title = "停止代理"
                } else if !(self?.proxyManager.isRunning ?? false) {
                    self?.statusItem.button?.title = "🔴"
                    self?.toggleItem?.title = "启动代理"
                }
            }
        }
        task.resume()
    }
}
