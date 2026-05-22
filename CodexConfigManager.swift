import AppKit
import Foundation

struct CodexRoute {
    let model: String
    let provider: String?

    var isProxy: Bool { provider == "local_proxy" }
    var label: String {
        if isProxy { return "代理 · \(model)" }
        return "GPT · \(model)"
    }
}

final class CodexConfigManager {
    private let fm = FileManager.default

    private var codexDir: URL {
        fm.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
    }

    private var bridgeDir: URL {
        codexDir.appendingPathComponent("codex-bridge")
    }

    private var configPath: URL {
        codexDir.appendingPathComponent("config.toml")
    }

    private var envPath: URL {
        bridgeDir.appendingPathComponent(".env")
    }

    private var authPath: URL {
        codexDir.appendingPathComponent("auth.json")
    }

    private var authBackupPath: URL {
        bridgeDir.appendingPathComponent("gpt-auth.backup.json")
    }

    private var configBackupPath: URL {
        bridgeDir.appendingPathComponent("gpt-config.backup.toml")
    }

    func currentRoute() -> CodexRoute {
        let content = (try? String(contentsOf: configPath, encoding: .utf8)) ?? ""
        let model = topLevelValue("model", in: content) ?? "gpt-5.5"
        let provider = topLevelValue("model_provider", in: content)
        return CodexRoute(model: model, provider: provider)
    }

    func switchToProxy() throws {
        try fm.createDirectory(at: bridgeDir, withIntermediateDirectories: true)

        let currentConfig = (try? String(contentsOf: configPath, encoding: .utf8)) ?? ""
        if currentRoute().isProxy == false {
            try currentConfig.write(to: configBackupPath, atomically: true, encoding: .utf8)
            try backupAuth()
        }

        let model = proxyDefaultModel()
        let providerSection = """

        [model_providers.local_proxy]
        name = "local_proxy"
        base_url = "http://127.0.0.1:\(proxyPort())/v1"
        wire_api = "responses"
        requires_openai_auth = true
        """

        var updated = currentConfig
        updated = setTopLevelValue("model", value: model, in: updated)
        updated = setTopLevelValue("model_provider", value: "local_proxy", in: updated)
        updated = upsertSection("model_providers.local_proxy", body: providerSection, in: updated)
        try updated.write(to: configPath, atomically: true, encoding: .utf8)
        try writeProxyAuth()
    }

    func switchToGPT() throws {
        try fm.createDirectory(at: bridgeDir, withIntermediateDirectories: true)

        if fm.fileExists(atPath: configBackupPath.path) {
            try? fm.removeItem(at: configPath)
            try fm.copyItem(at: configBackupPath, to: configPath)
            try restoreAuth()
        } else {
            let currentConfig = (try? String(contentsOf: configPath, encoding: .utf8)) ?? ""
            var updated = setTopLevelValue("model", value: "gpt-5.5", in: currentConfig)
            updated = removeTopLevelKey("model_provider", in: updated)
            try updated.write(to: configPath, atomically: true, encoding: .utf8)
        }
    }

    func proxyPort() -> String {
        envValue("PROXY_PORT") ?? "4000"
    }

    func restartCodex() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        task.arguments = ["-f", "/Applications/Codex.app/Contents/MacOS/Codex$"]
        try? task.run()
        task.waitUntilExit()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Codex.app"))
        }
    }

    private func backupAuth() throws {
        guard fm.fileExists(atPath: authPath.path) else { return }
        try? fm.removeItem(at: authBackupPath)
        try fm.copyItem(at: authPath, to: authBackupPath)
    }

    private func restoreAuth() throws {
        guard fm.fileExists(atPath: authBackupPath.path) else { return }
        try? fm.removeItem(at: authPath)
        try fm.copyItem(at: authBackupPath, to: authPath)
    }

    private func writeProxyAuth() throws {
        guard let proxyKey = proxyAuthKey() else { return }
        let obj: [String: Any] = ["auth_mode": "apikey", "OPENAI_API_KEY": proxyKey]
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: authPath, options: .atomic)
    }

    private func proxyAuthKey() -> String? {
        if let key = envValue("PROXY_AUTH_KEY"), !key.isEmpty { return key }
        guard let rawKeys = envValue("PROXY_KEYS") else { return nil }
        for rawEntry in rawKeys.components(separatedBy: ",") {
            let entry = rawEntry.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let sep = entry.lastIndex(of: ":") else { continue }
            let key = String(entry[..<sep]).trimmingCharacters(in: .whitespacesAndNewlines)
            let lock = String(entry[entry.index(after: sep)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty && lock == "*" { return key }
        }
        return nil
    }

    private func proxyDefaultModel() -> String {
        let provider = envValue("DEFAULT_PROVIDER") ?? fallbackProvider()
        let key: String
        let fallback: String
        switch provider {
        case "mimo":
            key = "MIMO_MODELS"
            fallback = "mimo-v2.5-pro"
        case "openai":
            key = "OPENAI_MODELS"
            fallback = "gpt-4o"
        default:
            key = "DEEPSEEK_MODELS"
            fallback = "deepseek-v4-pro"
        }
        return firstCsvValue(envValue(key)) ?? fallback
    }

    private func fallbackProvider() -> String {
        if envValue("DEEPSEEK_API_KEY") != nil || envValue("MY_DS_KEY") != nil { return "deepseek" }
        if envValue("MIMO_API_KEY") != nil { return "mimo" }
        if envValue("OPENAI_API_KEY") != nil { return "openai" }
        return "deepseek"
    }

    private func firstCsvValue(_ value: String?) -> String? {
        value?
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }

    private func envValue(_ key: String) -> String? {
        guard let content = try? String(contentsOf: envPath, encoding: .utf8) else { return nil }
        return topLevelValue(key, in: content)
    }

    private func topLevelValue(_ key: String, in content: String) -> String? {
        var inSection = false
        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") { inSection = true }
            if inSection || line.hasPrefix("#") { continue }
            guard line.hasPrefix("\(key)=") || line.hasPrefix("\(key) =") else { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if let comment = value.firstIndex(of: "#") {
                value = String(value[..<comment]).trimmingCharacters(in: .whitespaces)
            }
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            return value.isEmpty ? nil : value
        }
        return nil
    }

    private func setTopLevelValue(_ key: String, value: String, in content: String) -> String {
        var lines = content.components(separatedBy: "\n")
        var inSection = false
        var found = false
        let replacement = "\(key) = \(tomlQuote(value))"

        for i in lines.indices {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") { inSection = true }
            if inSection { continue }
            if trimmed.hasPrefix("\(key)=") || trimmed.hasPrefix("\(key) =") {
                lines[i] = replacement
                found = true
                break
            }
        }

        if !found {
            let insertAt = lines.firstIndex { $0.trimmingCharacters(in: .whitespaces).hasPrefix("[") } ?? lines.count
            lines.insert(replacement, at: insertAt)
        }

        return lines.joined(separator: "\n")
    }

    private func removeTopLevelKey(_ key: String, in content: String) -> String {
        var lines: [String] = []
        var inSection = false
        for line in content.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") { inSection = true }
            if !inSection && (trimmed.hasPrefix("\(key)=") || trimmed.hasPrefix("\(key) =")) {
                continue
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }

    private func upsertSection(_ section: String, body: String, in content: String) -> String {
        let header = "[\(section)]"
        let lines = content.components(separatedBy: "\n")
        var kept: [String] = []
        var skipping = false

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == header {
                skipping = true
                continue
            }
            if skipping && trimmed.hasPrefix("[") {
                skipping = false
            }
            if !skipping {
                kept.append(line)
            }
        }

        var output = kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !output.isEmpty { output += "\n" }
        output += body.trimmingCharacters(in: .whitespacesAndNewlines)
        output += "\n"
        return output
    }

    private func tomlQuote(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
