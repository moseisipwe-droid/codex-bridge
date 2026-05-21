import Foundation
import AppKit

class ProxyManager {
    private var process: Process?
    var onLogOutput: ((String) -> Void)?
    var isRunning: Bool { process?.isRunning ?? false }
    private var shouldAutoRestart = true
    
    /// 代理工作目录 ~/.codex/codex-bridge/
    private var workDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/codex-bridge")
    }
    private var envPath: URL { workDir.appendingPathComponent(".env") }
    private var proxyPath: URL { workDir.appendingPathComponent("proxy.mjs") }

    /// 首次部署资源（从 app bundle → ~/.codex/codex-bridge/）
    /// - returns: true 表示 .env 已就绪可启动；false 需要用户配置
    func ensureResources() -> Bool {
        let fm = FileManager.default
        // 创建目录
        try? fm.createDirectory(at: workDir, withIntermediateDirectories: true)
        // 部署 proxy.mjs（每次覆盖，保持更新）
        if let bundledProxy = Bundle.main.url(forResource: "proxy", withExtension: "mjs") {
            try? fm.removeItem(at: proxyPath)
            try? fm.copyItem(at: bundledProxy, to: proxyPath)
        }
        // 部署 package.json
        if let bundledPkg = Bundle.main.url(forResource: "package", withExtension: "json"),
           !fm.fileExists(atPath: workDir.appendingPathComponent("package.json").path) {
            try? fm.copyItem(at: bundledPkg, to: workDir.appendingPathComponent("package.json"))
        }
        // 部署 .env（仅首次）
        if !fm.fileExists(atPath: envPath.path) {
            if let bundledEnv = Bundle.main.url(forResource: "env", withExtension: "example") {
                try? fm.copyItem(at: bundledEnv, to: envPath)
            }
            return false
        }
        // 检查 .env 是否已配置（至少替换了占位符）
        guard let content = try? String(contentsOf: envPath, encoding: .utf8) else { return false }
        if content.contains("your-deepseek-key-here") || content.contains("replace-with-48-char-hex") {
            return false
        }
        return true
    }

    func start() {
        debugLog("start() called")
        shouldAutoRestart = true
        stop()

        // 0. 部署资源
        let ready = ensureResources()
        if !ready {
            onLogOutput?("[setup] .env 未配置，请在设置中填写 API Key")
            debugLog(".env not configured")
            // 弹窗提示
            DispatchQueue.main.async { [self] in
                let alert = NSAlert()
                alert.messageText = "需要配置 API Key"
                alert.informativeText = "首次使用需要在 .env 文件中填入你的 API Key。\n\n配置文件位置:\n\(envPath.path)\n\n填写后点击\"启动代理\"继续。"
                alert.addButton(withTitle: "打开 .env")
                alert.addButton(withTitle: "稍后设置")
                let resp = alert.runModal()
                if resp == .alertFirstButtonReturn {
                    NSWorkspace.shared.open(envPath)
                }
            }
            return
        }

        // 1. 找 Node.js
        guard let nodePath = findNode() else {
            debugLog("ERROR: Node.js not found")
            onLogOutput?("错误: 未找到 Node.js")
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "未找到 Node.js"
                alert.informativeText = "Codex Bridge 需要 Node.js 18+ 才能运行。\n请先安装: brew install node"
                alert.addButton(withTitle: "安装指导")
                alert.addButton(withTitle: "取消")
                let resp = alert.runModal()
                if resp == .alertFirstButtonReturn {
                    NSWorkspace.shared.open(URL(string: "https://nodejs.org")!)
                }
            }
            return
        }
        debugLog("node path: \(nodePath)")
        debugLog("proxy dir: \(workDir.path)")

        // 2. 启动进程
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["--env-file=\(envPath.path)", proxyPath.path]
        proc.currentDirectoryURL = workDir
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        if env["NODE_EXTRA_CA_CERTS"] == nil {
            let knownPaths = ["/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem"]
            for p in knownPaths {
                if FileManager.default.isReadableFile(atPath: p) {
                    env["NODE_EXTRA_CA_CERTS"] = p
                    debugLog("found CA cert: \(p)")
                    break
                }
            }
        }
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if let text = String(data: data, encoding: .utf8), !text.isEmpty {
                for line in text.components(separatedBy: "\n").filter({ !$0.isEmpty }) {
                    self?.onLogOutput?(line)
                    self?.debugLog("proxy: \(line)")
                }
            }
        }

        proc.terminationHandler = { [weak self] _ in
            guard let self = self else { return }
            self.onLogOutput?("[proxy] 已停止")
            self.debugLog("process terminated")
            self.process = nil
            if self.shouldAutoRestart {
                self.debugLog("auto-restarting...")
                self.onLogOutput?("[proxy] 自动重启中...")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.start()
                }
            }
        }

        do {
            try proc.run()
            process = proc
            debugLog("proxy started (PID \(proc.processIdentifier))")
            onLogOutput?("[proxy] 已启动 (PID \(proc.processIdentifier))")
        } catch {
            debugLog("ERROR: failed to start - \(error.localizedDescription)")
            onLogOutput?("错误: 启动失败 - \(error.localizedDescription)")
        }
    }

    func stop() {
        if let proc = process, proc.isRunning {
            debugLog("stopping process \(proc.processIdentifier)")
            shouldAutoRestart = false
            proc.terminate()
            let deadline = Date(timeIntervalSinceNow: 1)
            while proc.isRunning && Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }
            if proc.isRunning {
                debugLog("force killing")
                kill(proc.processIdentifier, SIGKILL)
                proc.waitUntilExit()
            }
        }
        process = nil
    }

    // MARK: - Private

    private func debugLog(_ msg: String) {
        print("[ProxyManager]", msg)
        let line = "[ProxyManager] \(msg)\n"
        if let data = line.data(using: .utf8) {
            let url = URL(fileURLWithPath: "/tmp/codex-debug.log")
            if FileManager.default.fileExists(atPath: url.path) {
                if let handle = try? FileHandle(forWritingTo: url) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    if #available(macOS 10.15, *) { try? handle.close() }
                }
            } else {
                try? data.write(to: url)
            }
        }
    }

    private func findNode() -> String? {
        let paths = [
            "/opt/homebrew/bin/node",
            "/opt/homebrew/opt/node@22/bin/node",
            "/usr/local/bin/node",
        ]
        for p in paths {
            if FileManager.default.isExecutableFile(atPath: p) {
                debugLog("found node at: \(p)")
                return p
            }
        }
        debugLog("checking PATH with proxy PATH...")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["which", "node"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        task.environment = env
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let found = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let found = found, !found.isEmpty {
            debugLog("found node via PATH: \(found)")
        } else {
            debugLog("node not found anywhere")
        }
        return found
    }
}
