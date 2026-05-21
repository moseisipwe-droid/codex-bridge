import AppKit

class DashboardWindowController: NSWindowController {
    private let port = "4000"
    private let baseURL: String
    private var pollTimer: Timer?
    private var lastLogTS: Int = 0
    // 缓存当前供应商配置，供模型切换用
    private var currentProviderConfigs: [String: [String: Any]] = [:]
    private var currentEnabledList: [String] = []
    // 本地模型切换缓存（重启生效前暂存，防止轮询覆盖）
    private var pendingDefaultModels: [String: String] = [:]

    // 20个主流厂商模板
    private static let providerTemplates: [(keywords: [String], name: String, base: String, models: String)] = [
        (["openai","gpt","chatgpt"],            "OpenAI",       "https://api.openai.com/v1",                          "gpt-4o,gpt-4o-mini,o4-mini"),
        (["deepseek"],                           "DeepSeek",     "https://api.deepseek.com/v1",                        "deepseek-chat,deepseek-reasoner,deepseek-v4-pro,deepseek-v4-flash"),
        (["claude","anthropic"],                  "Claude",       "https://api.anthropic.com/v1",                       "claude-sonnet-4-20250514,claude-haiku-3-5"),
        (["gemini","google"],                     "Gemini",       "https://generativelanguage.googleapis.com/v1beta/openai/",  "gemini-2.5-flash,gemini-2.5-pro"),
        (["kimi","moonshot"],                     "Kimi",         "https://api.moonshot.cn/v1",                         "kimi-k2.5,kimi-latest"),
        (["mimo","xiaomi"],                       "小米 MiMo",    "https://token-plan-cn.xiaomimimo.com/v1",            "mimo-v2.5-pro"),
        (["zhipu","glm","bigmodel"],              "智谱 GLM",     "https://open.bigmodel.cn/api/paas/v4",              "glm-4-plus,glm-4-flash"),
        (["qwen","tongyi","ali","dashscope"],     "通义千问",     "https://dashscope.aliyuncs.com/compatible-mode/v1",  "qwen-plus,qwen-max,qwen-turbo"),
        (["baidu","ernie","qianfan"],             "百度千帆",     "https://aip.baidubce.com/rpc/2.0/ai/custom/v1/wenxinworkshop/chat",  "ernie-4.0,ernie-speed-128k"),
        (["doubao","volc","ark","bytedance"],     "火山引擎",     "https://ark.cn-beijing.volces.com/api/v3",           "doubao-pro-32k,doubao-lite-32k"),
        (["xunfei","spark","xinghuo","iflytek"],  "讯飞星火",     "https://spark-api.xf-yun.com/v3.5",                  "spark-4.0,spark-3.5"),
        (["hunyuan","tencent"],                   "腾讯混元",     "https://api.hunyuan.cloud.tencent.com/v1",           "hunyuan-pro,hunyuan-turbo"),
        (["baichuan"],                            "百川",         "https://api.baichuan-ai.com/v1",                     "baichuan4,baichuan3-turbo"),
        (["yi","lingyi","01ai"],                  "零一万物",     "https://api.lingyiwanwu.com/v1",                     "yi-lightning,yi-large"),
        (["stepfun","jieyue"],                    "阶跃星辰",     "https://api.stepfun.com/v1",                         "step-2,step-1"),
        (["siliconflow"],                         "SiliconFlow",  "https://api.siliconflow.cn/v1",                      "deepseek-ai/DeepSeek-V3,Qwen/Qwen2.5-72B"),
        (["groq"],                                "Groq",         "https://api.groq.com/openai/v1",                     "llama-3.3-70b-versatile,mixtral-8x7b"),
        (["xai","grok"],                          "xAI Grok",     "https://api.x.ai/v1",                               "grok-3,grok-3-mini"),
        (["perplexity","sonar"],                  "Perplexity",   "https://api.perplexity.ai",                          "sonar-pro,sonar"),
        (["together"],                            "Together",     "https://api.together.xyz/v1",                        "meta-llama/Llama-3.3-70B"),
    ]

    // 顶部
    private let statusDot = NSView()
    private let statusText = NSTextField(labelWithString: "连接中...")
    // 卡片
    private let cardStatus  = NSTextField(labelWithString: "-")
    private let cardUptime  = NSTextField(labelWithString: "-")
    private let cardTotal   = NSTextField(labelWithString: "-")
    private let cardEnabled = NSTextField(labelWithString: "-")
    private let cardEnabledSub = NSTextField(labelWithString: "")
    // 供应商
    private let providerStack = NSStackView()
    private let setupBanner = NSTextField(labelWithString: "")
    // 日志
    private let logTextView = NSTextView()

    override var windowNibName: NSNib.Name? { nil }

    init() {
        baseURL = "http://127.0.0.1:\(port)"
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "Codex Bridge"
        window.minSize = NSSize(width: 380, height: 400)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        setupUI()
    }

    required init?(coder: NSCoder) { nil }

    func showDashboard() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        startPolling()
    }

    func hideDashboard() {
        close()
        stopPolling()
    }

    // MARK: - 布局

    private func setupUI() {
        guard let cv = window?.contentView else { return }

        let header = buildHeader()
        cv.addSubview(header)

        let cards = buildCards()
        cv.addSubview(cards)

        let providerSection = buildProviderSection()
        cv.addSubview(providerSection)

        let logSection = buildLogSection()
        cv.addSubview(logSection)

        let pad: CGFloat = 12
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: cv.topAnchor, constant: pad),
            header.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: pad),
            header.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -pad),

            cards.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            cards.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: pad),
            cards.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -pad),

            providerSection.topAnchor.constraint(equalTo: cards.bottomAnchor, constant: 12),
            providerSection.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: pad),
            providerSection.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -pad),

            logSection.topAnchor.constraint(equalTo: providerSection.bottomAnchor, constant: 8),
            logSection.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: pad),
            logSection.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -pad),
            logSection.heightAnchor.constraint(equalToConstant: 220),
        ])
    }

    private func buildHeader() -> NSView {
        let row = NSStackView(views: [])
        row.orientation = .horizontal
        row.spacing = 6
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        row.heightAnchor.constraint(equalToConstant: 28).isActive = true

        statusDot.wantsLayer = true
        statusDot.layer?.cornerRadius = 5
        statusDot.layer?.backgroundColor = NSColor.systemOrange.cgColor
        statusDot.translatesAutoresizingMaskIntoConstraints = false
        statusDot.widthAnchor.constraint(equalToConstant: 10).isActive = true
        statusDot.heightAnchor.constraint(equalToConstant: 10).isActive = true

        let title = NSTextField(labelWithString: "Codex Bridge")
        title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)

        statusText.font = NSFont.systemFont(ofSize: 12)
        statusText.textColor = .secondaryLabelColor

        row.addArrangedSubview(statusDot)
        row.addArrangedSubview(title)
        row.addArrangedSubview(statusText)
        row.addArrangedSubview(NSView())

        return row
    }

    private func buildCards() -> NSView {
        let cards = NSStackView(views: [
            makeCard(label: "状态", value: cardStatus),
            makeCard(label: "运行时间", value: cardUptime),
            makeCard(label: "总请求", value: cardTotal),
            makeCard(label: "已启用", value: cardEnabled, sub: cardEnabledSub),
        ])
        cards.orientation = .horizontal
        cards.spacing = 6
        cards.distribution = .fillEqually
        cards.translatesAutoresizingMaskIntoConstraints = false
        cards.heightAnchor.constraint(equalToConstant: 64).isActive = true
        return cards
    }

    private func makeCard(label: String, value: NSTextField, sub: NSTextField? = nil) -> NSView {
        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        card.layer?.cornerRadius = 6
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor.separatorColor.cgColor
        card.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [])
        stack.orientation = .vertical
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: card.centerYAnchor),
        ])

        let lbl = NSTextField(labelWithString: label)
        lbl.font = NSFont.systemFont(ofSize: 10)
        lbl.textColor = .secondaryLabelColor

        value.font = NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .medium)
        value.textColor = .labelColor

        stack.addArrangedSubview(lbl)
        stack.addArrangedSubview(value)

        if let sub = sub {
            sub.font = NSFont.systemFont(ofSize: 10)
            sub.textColor = .secondaryLabelColor
            sub.lineBreakMode = .byTruncatingTail
            stack.addArrangedSubview(sub)
        }

        return card
    }

    // MARK: - 供应商

    private func buildProviderSection() -> NSView {
        let container = NSStackView(views: [])
        container.orientation = .vertical
        container.spacing = 6
        container.translatesAutoresizingMaskIntoConstraints = false

        let headerRow = NSStackView(views: [])
        headerRow.orientation = .horizontal
        headerRow.spacing = 6
        headerRow.alignment = .centerY

        let header = NSTextField(labelWithString: "供应商")
        header.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        headerRow.addArrangedSubview(header)
        headerRow.addArrangedSubview(NSView())

        let addBtn = NSButton(title: "+", target: self, action: #selector(showAddProviderSheet))
        addBtn.bezelStyle = .smallSquare
        addBtn.font = NSFont.systemFont(ofSize: 13, weight: .bold)
        addBtn.controlSize = .small
        addBtn.setContentHuggingPriority(.required, for: .horizontal)
        headerRow.addArrangedSubview(addBtn)

        container.addArrangedSubview(headerRow)

        setupBanner.font = NSFont.systemFont(ofSize: 11)
        setupBanner.textColor = .secondaryLabelColor
        setupBanner.isSelectable = true
        container.addArrangedSubview(setupBanner)

        providerStack.orientation = .vertical
        providerStack.spacing = 4
        container.addArrangedSubview(providerStack)

        return container
    }

    private func buildProviderCard(name: String, config: [String: Any], count: Int) -> NSView {
        let c = config["configured"] as? Bool ?? false
        let models = config["models"] as? [String] ?? []
        let defaultModel = pendingDefaultModels[name] ?? config["defaultModel"] as? String ?? ""
        let isCustom = config["custom"] as? Bool ?? false

        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        card.layer?.cornerRadius = 5
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor.separatorColor.cgColor
        card.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [])
        row.orientation = .horizontal
        row.spacing = 6
        row.alignment = .centerY
        row.edgeInsets = NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10)
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            row.topAnchor.constraint(equalTo: card.topAnchor),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])

        let nameField = NSTextField(labelWithString: displayName(name))
        nameField.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        nameField.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        let statusField = NSTextField(labelWithString: c ? "● 已配置" : "○ 未配置")
        statusField.font = NSFont.systemFont(ofSize: 10)
        statusField.textColor = c ? .systemGreen : .secondaryLabelColor
        statusField.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        let countField = NSTextField(labelWithString: "\(count)")
        countField.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        countField.textColor = .secondaryLabelColor
        countField.alignment = .right
        countField.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        row.addArrangedSubview(nameField)
        row.addArrangedSubview(statusField)

        // 模型选择下拉
        if c && !models.isEmpty {
            let popup = NSPopUpButton(frame: .zero, pullsDown: false)
            popup.font = NSFont.systemFont(ofSize: 10)
            popup.controlSize = .small
            popup.setContentHuggingPriority(.defaultHigh, for: .horizontal)
            popup.target = self
            popup.action = #selector(modelChanged(_:))
            popup.identifier = NSUserInterfaceItemIdentifier(name)

            popup.addItems(withTitles: models)
            if let idx = models.firstIndex(of: defaultModel) {
                popup.selectItem(at: idx)
            }

            row.addArrangedSubview(popup)
        }

        // 自定义供应商可删除
        if isCustom {
            let delBtn = NSButton(title: "✕", target: self, action: #selector(removeCustomProvider(_:)))
            delBtn.bezelStyle = .smallSquare
            delBtn.font = NSFont.systemFont(ofSize: 9)
            delBtn.controlSize = .small
            delBtn.setContentHuggingPriority(.required, for: .horizontal)
            delBtn.identifier = NSUserInterfaceItemIdentifier(name)
            row.addArrangedSubview(delBtn)
        }

        row.addArrangedSubview(countField)

        return card
    }

    @objc private func modelChanged(_ sender: NSPopUpButton) {
        guard let name = sender.identifier?.rawValue,
              let model = sender.selectedItem?.title else { return }
        pendingDefaultModels[name] = model
        switchModel(name: name, model: model)
    }

    @objc private func showAddProviderSheet() {
        let fw: CGFloat = 340
        let rowH: CGFloat = 28
        let pad: CGFloat = 8

        let providerPopup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: fw, height: 24), pullsDown: false)
        providerPopup.addItem(withTitle: "自定义")
        for t in Self.providerTemplates {
            providerPopup.addItem(withTitle: t.name)
        }
        providerPopup.target = self
        providerPopup.action = #selector(providerTemplateSelected(_:))
        providerPopup.tag = 100

        let nameField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        nameField.placeholderString = "名称"
        nameField.tag = 101

        let keyField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        keyField.placeholderString = "API Key"

        let baseField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        baseField.placeholderString = "Base URL"
        baseField.tag = 102

        let modelsField = NSTextField(frame: NSRect(x: 0, y: 0, width: fw, height: rowH))
        modelsField.placeholderString = "模型 (逗号分隔)"
        modelsField.tag = 103

        let hintLabel = NSTextField(labelWithString: "")
        hintLabel.font = NSFont.systemFont(ofSize: 11)
        hintLabel.textColor = .secondaryLabelColor
        hintLabel.frame = NSRect(x: 0, y: 0, width: fw, height: 16)
        hintLabel.tag = 104

        // 手动算总高
        let totalH: CGFloat = 24 + pad + rowH + pad + rowH + pad + rowH + pad + rowH + 4 + 16
        let c = NSView(frame: NSRect(x: 0, y: 0, width: fw, height: totalH))
        c.autoresizingMask = []

        // 逐个定位
        var y: CGFloat = totalH - 24
        providerPopup.frame.origin = NSPoint(x: 0, y: y)

        y -= pad + rowH
        nameField.frame.origin = NSPoint(x: 0, y: y)

        y -= pad + rowH
        keyField.frame.origin = NSPoint(x: 0, y: y)

        y -= pad + rowH
        baseField.frame.origin = NSPoint(x: 0, y: y)

        y -= pad + rowH
        modelsField.frame.origin = NSPoint(x: 0, y: y)

        y -= 4 + 16
        hintLabel.frame.origin = NSPoint(x: 0, y: y)

        c.addSubview(providerPopup)
        c.addSubview(nameField)
        c.addSubview(keyField)
        c.addSubview(baseField)
        c.addSubview(modelsField)
        c.addSubview(hintLabel)

        let alert = NSAlert()
        alert.messageText = "添加供应商"
        alert.informativeText = "选择厂商或自定义，填写信息后添加"
        alert.accessoryView = c
        alert.addButton(withTitle: "添加")
        alert.addButton(withTitle: "取消")

        let resp = alert.runModal()
        if resp == .alertFirstButtonReturn {
            let name = nameField.stringValue.trimmingCharacters(in: .whitespaces)
            let key = keyField.stringValue.trimmingCharacters(in: .whitespaces)
            let base = baseField.stringValue.trimmingCharacters(in: .whitespaces)
            let models = modelsField.stringValue.trimmingCharacters(in: .whitespaces)
            addCustomProvider(name: name, key: key, base: base, models: models)
        }
    }

    @objc private func providerTemplateSelected(_ sender: NSPopUpButton) {
        let idx = sender.indexOfSelectedItem
        guard idx > 0 else { return }
        let t = Self.providerTemplates[idx - 1]

        if let container = sender.superview {
            (container.viewWithTag(101) as? NSTextField)?.stringValue = t.keywords[0]
            (container.viewWithTag(102) as? NSTextField)?.stringValue = t.base
            (container.viewWithTag(103) as? NSTextField)?.stringValue = t.models
        }
        // 更新提示标签
        if let container = sender.superview, let hint = container.viewWithTag(104) as? NSTextField {
            hint.stringValue = "↳ 已选择: \(t.name)"
        }
    }


    private func addCustomProvider(name: String, key: String, base: String, models: String) {
        guard !name.isEmpty, !key.isEmpty else { return }

        let entry: [String: Any] = [
            "name": name,
            "key": key,
            "base": base.isEmpty ? "https://api.openai.com/v1" : base,
            "models": models.isEmpty ? "gpt-4o" : models,
        ]

        updateEnvFile { current in
            // Remove existing ADDITIONAL_PROVIDERS line if present
            var lines = current.components(separatedBy: "\n").filter {
                !$0.hasPrefix("ADDITIONAL_PROVIDERS")
            }
            // Find existing set from env
            var existing: [[String: Any]] = []
            for line in current.components(separatedBy: "\n") {
                if line.hasPrefix("ADDITIONAL_PROVIDERS=") {
                    let val = line.dropFirst("ADDITIONAL_PROVIDERS=".count).trimmingCharacters(in: .whitespaces)
                    if let d = val.data(using: .utf8), let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
                        existing = arr
                    }
                }
            }
            existing.append(entry)
            if let updated = try? JSONSerialization.data(withJSONObject: existing),
               let updatedStr = String(data: updated, encoding: .utf8) {
                lines.append("ADDITIONAL_PROVIDERS=\(updatedStr)")
            }
            return lines.joined(separator: "\n")
        }
    }

    @objc private func removeCustomProvider(_ sender: NSButton) {
        guard let name = sender.identifier?.rawValue else { return }

        updateEnvFile { current in
            var lines = current.components(separatedBy: "\n").filter {
                !$0.hasPrefix("ADDITIONAL_PROVIDERS")
            }
            var existing: [[String: Any]] = []
            for line in current.components(separatedBy: "\n") {
                if line.hasPrefix("ADDITIONAL_PROVIDERS=") {
                    let val = line.dropFirst("ADDITIONAL_PROVIDERS=".count).trimmingCharacters(in: .whitespaces)
                    if let d = val.data(using: .utf8), let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
                        existing = arr
                    }
                }
            }
            existing = existing.filter { ($0["name"] as? String) != name }
            if let updated = try? JSONSerialization.data(withJSONObject: existing),
               let updatedStr = String(data: updated, encoding: .utf8) {
                lines.append("ADDITIONAL_PROVIDERS=\(updatedStr)")
            }
            return lines.joined(separator: "\n")
        }
    }

    private func switchModel(name: String, model: String) {
        let knownEnvKeys: [String: String] = [
            "deepseek": "DEEPSEEK_MODELS",
            "mimo": "MIMO_MODELS",
            "openai": "OPENAI_MODELS",
        ]

        updateEnvFile { current in
            var lines = current.components(separatedBy: "\n")

            if let envKey = knownEnvKeys[name] {
                // 内置供应商 — 把模型排到 *_MODELS 列表第一个
                var found = false
                lines = lines.map { line in
                    if line.hasPrefix("\(envKey)=") && !found {
                        found = true
                        let val = line.dropFirst("\(envKey)=".count)
                        var mods = val.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                        if !mods.isEmpty {
                            mods.removeAll { $0 == model }
                            mods.insert(model, at: 0)
                        } else {
                            mods = [model]
                        }
                        return "\(envKey)=\(mods.joined(separator: ","))"
                    }
                    return line
                }
                if !found {
                    lines.append("\(envKey)=\(model)")
                }
                return lines.joined(separator: "\n")
            }

            // 自定义供应商 — 更新 ADDITIONAL_PROVIDERS 里的 models
            lines = lines.filter { !$0.hasPrefix("ADDITIONAL_PROVIDERS") }
            var existing: [[String: Any]] = []
            for line in current.components(separatedBy: "\n") {
                if line.hasPrefix("ADDITIONAL_PROVIDERS=") {
                    let val = line.dropFirst("ADDITIONAL_PROVIDERS=".count).trimmingCharacters(in: .whitespaces)
                    if let d = val.data(using: .utf8), let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
                        existing = arr
                    }
                }
            }
            if let idx = existing.firstIndex(where: { ($0["name"] as? String) == name }) {
                let currentModels = (existing[idx]["models"] as? String) ?? ""
                var mods = currentModels.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                mods.removeAll { $0 == model }
                mods.insert(model, at: 0)
                existing[idx]["models"] = mods.joined(separator: ",")
            }
            if let updated = try? JSONSerialization.data(withJSONObject: existing),
               let updatedStr = String(data: updated, encoding: .utf8) {
                lines.append("ADDITIONAL_PROVIDERS=\(updatedStr)")
            }
            return lines.joined(separator: "\n")
        }
    }

    private func updateEnvFile(_ transform: @escaping (String) -> String) {
        guard let url = URL(string: "\(baseURL)/admin/api/config") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = json["content"] as? String else { return }

            let newContent = transform(content)
            var req = URLRequest(url: url)
            req.httpMethod = "PUT"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["content": newContent])

            URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
                guard let self = self else { return }
                // Save ok, now restart
                guard let restartURL = URL(string: "\(self.baseURL)/admin/api/restart") else { return }
                var rreq = URLRequest(url: restartURL)
                rreq.httpMethod = "POST"
                URLSession.shared.dataTask(with: rreq).resume()
            }.resume()
        }.resume()
    }

    private func buildLogSection() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false

        let label = NSTextField(labelWithString: "实时日志")
        label.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.borderType = .lineBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(scroll)

        logTextView.isEditable = false
        logTextView.isSelectable = true
        logTextView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        logTextView.textColor = .textColor
        logTextView.backgroundColor = NSColor(white: 0.08, alpha: 1)
        logTextView.textContainerInset = NSSize(width: 6, height: 6)
        logTextView.isHorizontallyResizable = false
        logTextView.textContainer?.widthTracksTextView = true
        scroll.documentView = logTextView

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: container.topAnchor),
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor),

            scroll.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 200),
        ])

        return container
    }

    // MARK: - 网络

    private func startPolling() {
        fetchStatus()
        fetchLogs()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.fetchStatus()
            self?.fetchLogs()
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func fetchStatus() {
        guard let url = URL(string: "\(baseURL)/admin/api/status") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, resp, _ in
            guard let self = self else { return }
            if let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                DispatchQueue.main.async { self.updateStatus(json) }
            } else {
                DispatchQueue.main.async { self.showSetupBanner() }
            }
        }.resume()
    }

    private func fetchLogs() {
        guard let url = URL(string: "\(baseURL)/admin/api/logs-recent") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            DispatchQueue.main.async { self.appendLogs(entries) }
        }.resume()
    }

    private func showSetupBanner() {
        statusDot.layer?.backgroundColor = NSColor.systemRed.cgColor
        statusText.stringValue = "代理未运行"
        setupBanner.stringValue = "首次使用？编辑 ~/.codex/codex-bridge/.env 填入 API Key，然后点击菜单栏 → 启动代理"
    }

    private func updateStatus(_ d: [String: Any]) {
        statusDot.layer?.backgroundColor = NSColor.systemGreen.cgColor
        setupBanner.stringValue = ""

        let p = d["port"] as? String ?? "4000"
        statusText.stringValue = ":\(p) · 运行中"

        cardStatus.stringValue = "运行中"
        let uptimeSec = (d["uptime"] as? Int ?? 0) / 1000
        cardUptime.stringValue = ago(uptimeSec)
        cardTotal.stringValue = "\(d["total"] as? Int ?? 0)"

        let enabled = d["enabledProviders"] as? [String] ?? []
        cardEnabled.stringValue = "\(enabled.count)"
        cardEnabledSub.stringValue = enabled.map { displayName($0) }.joined(separator: ", ")

        currentEnabledList = enabled

        let configs = d["providerConfigs"] as? [String: [String: Any]] ?? [:]
        currentProviderConfigs = configs
        let byProvider = d["byProvider"] as? [String: Int] ?? [:]

        // 清除已生效的 pending 切换
        for (name, pendingModel) in pendingDefaultModels {
            if let cfg = configs[name], (cfg["defaultModel"] as? String) == pendingModel {
                pendingDefaultModels.removeValue(forKey: name)
            }
        }

        providerStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let configured = configs.filter { ($0.value["configured"] as? Bool) == true }
        if configured.isEmpty {
            let empty = NSTextField(labelWithString: "无已配置的供应商 — 点击 + 添加")
            empty.font = NSFont.systemFont(ofSize: 11)
            empty.textColor = .secondaryLabelColor
            providerStack.addArrangedSubview(empty)
        } else {
            for (name, cfg) in configured {
                let count = byProvider[name] ?? 0
                let card = buildProviderCard(name: name, config: cfg, count: count)
                providerStack.addArrangedSubview(card)
            }
        }
    }

    private func appendLogs(_ entries: [[String: Any]]) {
        let storage = logTextView.textStorage ?? NSTextStorage()
        let new = entries.filter { ($0["ts"] as? Int ?? 0) > lastLogTS }
        for entry in new {
            lastLogTS = max(lastLogTS, entry["ts"] as? Int ?? 0)
            let ts = entry["ts"] as? Int ?? 0
            let level = entry["level"] as? String ?? "info"
            let msg = entry["msg"] as? String ?? ""
            let time = fmtDate(Date(timeIntervalSince1970: TimeInterval(ts) / 1000))
            let color: NSColor = level == "error" ? .systemRed
                : level == "warn" ? .systemYellow
                : level == "access" ? .systemBlue
                : level == "debug" ? .tertiaryLabelColor
                : .textColor
            let line = NSAttributedString(string: "\(time) \(msg)\n", attributes: [
                .foregroundColor: color,
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            ])
            storage.append(line)
        }
        if !new.isEmpty {
            logTextView.scrollToEndOfDocument(nil)
        }
    }

    // MARK: - 工具

    private func ago(_ s: Int) -> String {
        if s < 60 { return "\(s)秒" }
        if s < 3600 { return "\(s / 60)分 \(s % 60)秒" }
        return "\(s / 3600)时 \((s % 3600) / 60)分"
    }

    private func fmtDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: d)
    }

    private func displayName(_ n: String) -> String {
        ["deepseek": "DeepSeek", "mimo": "MiMo", "openai": "OpenAI"][n] ?? n
    }
}
