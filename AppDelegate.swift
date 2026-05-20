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
        toggleItem = menu.addItem(withTitle: "停止代理", action: #selector(toggleProxy), keyEquivalent: "s")
        toggleItem.target = self
        menu.addItem(.separator())
        let quitItem = menu.addItem(withTitle: "退出", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        statusItem.menu = menu

        proxyManager.onLogOutput = { print("[proxy]", $0) }
        proxyManager.start()

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

    @objc private func quitApp() {
        proxyManager.stop()
        NSApp.terminate(nil)
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
