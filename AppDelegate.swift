import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var toggleItem: NSMenuItem!
    private var windowItem: NSMenuItem!
    private var routeItem: NSMenuItem!
    private var switchProxyItem: NSMenuItem!
    private var switchGPTItem: NSMenuItem!
    private let proxyManager = ProxyManager()
    private let dashboard = DashboardWindowController()
    private let codexConfig = CodexConfigManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🟡"

        let menu = NSMenu()
        windowItem = menu.addItem(withTitle: "显示窗口", action: #selector(toggleWindow), keyEquivalent: "w")
        windowItem.target = self
        menu.addItem(.separator())
        routeItem = menu.addItem(withTitle: "Codex: 读取中...", action: nil, keyEquivalent: "")
        routeItem.isEnabled = false
        switchProxyItem = menu.addItem(withTitle: "使用代理模型", action: #selector(switchToProxyRoute), keyEquivalent: "p")
        switchProxyItem.target = self
        switchGPTItem = menu.addItem(withTitle: "切换到 GPT", action: #selector(switchToGPTRoute), keyEquivalent: "g")
        switchGPTItem.target = self
        menu.addItem(.separator())
        toggleItem = menu.addItem(withTitle: "启动代理并切到代理", action: #selector(toggleProxy), keyEquivalent: "s")
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
            if codexConfig.currentRoute().isProxy {
                startProxyOnly()
            } else {
                updateRouteMenu(proxyHealthy: false)
            }
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

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if proxyManager.isRunning && codexConfig.currentRoute().isProxy {
            let alert = NSAlert()
            alert.messageText = "代理正在使用中"
            alert.informativeText = "退出 Codex Bridge 会停止本地代理，正在使用代理模型的 Codex 会话会断开。"
            alert.addButton(withTitle: "取消")
            alert.addButton(withTitle: "停止代理并切回 GPT")
            let resp = alert.runModal()
            if resp == .alertFirstButtonReturn {
                return .terminateCancel
            }
            stopProxyAndRestoreGPT(showErrors: false)
        }
        return .terminateNow
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
            stopProxyAndRestoreGPT()
        } else {
            startProxyAndRoute()
        }
    }

    @objc private func switchToProxyRoute() {
        startProxyAndRoute()
    }

    @objc private func switchToGPTRoute() {
        stopProxyAndRestoreGPT()
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
        if !deepseek.isEmpty { lines.append("DEEPSEEK_API_KEY=\(deepseek)") }
        if !mimo.isEmpty { lines.append("MIMO_API_KEY=\(mimo)") }
        if !openai.isEmpty { lines.append("OPENAI_API_KEY=\(openai)") }
        lines.append("DEEPSEEK_BASE_URL=https://api.deepseek.com/v1")
        lines.append("DEEPSEEK_MODELS=deepseek-chat,deepseek-v4-flash,deepseek-v4-pro,deepseek-reasoner")
        lines.append("DEFAULT_PROVIDER=deepseek")
        lines.append("")
        let content = lines.joined(separator: "\n")

        try? content.write(to: envPath, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let alert = NSAlert()
            alert.messageText = "配置完成"
            alert.informativeText = "已自动写入 .env，并会在启动代理时把 Codex 切到 local_proxy；停止代理时会恢复 GPT 配置。"
            alert.addButton(withTitle: "知道了")
            alert.runModal()
        }
        startProxyAndRoute()
    }

    private func startProxyAndRoute(showErrors: Bool = true) {
        proxyManager.start()
        if proxyManager.isRunning {
            do {
                try codexConfig.switchToProxy()
                showRestartCodexAlert(forProxy: true)
            } catch {
                if showErrors { showConfigError("切换到代理模型失败", error) }
            }
        }
        updateRouteMenu(proxyHealthy: proxyManager.isRunning)
    }

    private func startProxyOnly() {
        proxyManager.start()
        updateRouteMenu(proxyHealthy: proxyManager.isRunning)
    }

    private func stopProxyAndRestoreGPT(showErrors: Bool = true) {
        proxyManager.stop()
        do {
            try codexConfig.switchToGPT()
            showRestartCodexAlert(forProxy: false)
        } catch {
            if showErrors { showConfigError("恢复 GPT 配置失败", error) }
        }
        updateRouteMenu(proxyHealthy: false)
    }

    private func showRestartCodexAlert(forProxy: Bool) {
        DispatchQueue.main.async { [self] in
            let mode = forProxy ? "代理" : "GPT"
            let alert = NSAlert()
            alert.messageText = "配置已切换为 \(mode) 模式"
            alert.informativeText = "需要重启 Codex 桌面版才能生效。是否立即重启？"
            alert.addButton(withTitle: "重启 Codex")
            alert.addButton(withTitle: "稍后手动重启")
            if alert.runModal() == .alertFirstButtonReturn {
                codexConfig.restartCodex()
            }
        }
    }

    private func showConfigError(_ title: String, _ error: Error) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "知道了")
            alert.runModal()
        }
    }

    private func checkHealth() {
        guard let url = URL(string: "http://127.0.0.1:\(proxyPort())/health") else { return }
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            DispatchQueue.main.async {
                let healthy = error == nil
                if error == nil {
                    self?.toggleItem?.title = "停止代理并恢复 GPT"
                } else if !(self?.proxyManager.isRunning ?? false) {
                    self?.toggleItem?.title = "启动代理并切到代理"
                }
                self?.updateRouteMenu(proxyHealthy: healthy)
            }
        }
        task.resume()
    }

    private func updateRouteMenu(proxyHealthy: Bool?) {
        let route = codexConfig.currentRoute()
        routeItem?.title = "Codex: \(route.label)"
        switchProxyItem?.state = route.isProxy ? .on : .off
        switchGPTItem?.state = route.isProxy ? .off : .on

        let routeMark = route.isProxy ? "代理" : "GPT"
        if proxyHealthy == true {
            statusItem.button?.title = "🟢 \(routeMark)"
        } else if proxyManager.isRunning {
            statusItem.button?.title = "🟡 \(routeMark)"
        } else {
            statusItem.button?.title = "🔴 \(routeMark)"
        }
    }

    private func proxyPort() -> String {
        envValue("PROXY_PORT") ?? "4000"
    }

    private func envValue(_ key: String) -> String? {
        let envPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/codex-bridge/.env")
        guard let content = try? String(contentsOf: envPath, encoding: .utf8) else { return nil }
        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#") || !line.hasPrefix("\(key)=") { continue }
            var value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            return value.isEmpty ? nil : value
        }
        return nil
    }
}
