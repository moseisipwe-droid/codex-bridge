import Foundation

class ProxyManager {
    private var process: Process?
    var onLogOutput: ((String) -> Void)?
    var isRunning: Bool { process?.isRunning ?? false }
    private var shouldAutoRestart = true

    private func debugLog(_ msg: String) {
        print("[ProxyManager]", msg)
        // Also write to a file in /tmp
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

    func start() {
        debugLog("start() called")
        shouldAutoRestart = true
        stop()

        guard let nodePath = findNode() else {
            debugLog("ERROR: Node.js not found")
            onLogOutput?("错误: 未找到 Node.js")
            return
        }
        debugLog("node path: \(nodePath)")

        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/codex-bridge")
        debugLog("proxy dir: \(dir.path)")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["--env-file=\(dir.path)/.env", "\(dir.path)/proxy.mjs"]
        proc.currentDirectoryURL = dir
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        // 从 shell 继承 SSL 证书变量（GUI 应用 launchd 环境不包含 .zshrc 里的变量）
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
