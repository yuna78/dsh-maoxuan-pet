// desktop/maoxuan-pet.swift — 「鲸鱼娘·小毛」独立桌宠壳（macOS）
//
// 学 dsh-tauri-pet 的原生窗口思路，但**进程独立于 DSH**：
//   - 透明、无边框、置顶、跨所有 Space 的 NSWindow + WKWebView
//     （对应 Tauri 的 transparent / alwaysOnTop / visibleOnAllWorkspaces / skipTaskbar）；
//   - 点击穿透用 hitTest 白名单矩形实现（等价 dsh-tauri 的 set_pet_input_region）；
//   - 宿主数据由本进程 URLSession 轮询（等价宠物窗口的 session stream），
//     绕开 WKWebView 的跨域限制，页面只管渲染；
//   - DSH 主窗口最小化甚至退出都不影响她站着——她是自己的进程。
//
// 用法：maoxuan-pet [--origin=http://127.0.0.1:3081 | --port=3081] [--reset] [--verbose]
// 退出：右键小毛 → 退出小毛。

import AppKit
import WebKit

// MARK: - 配置

enum Shell {
    static var origin = "http://127.0.0.1:3081"
    static var verbose = false
    static let statePath = "/api/dsh-maoxuan-pet.state"
    static let generatePath = "/api/dsh-maoxuan-pet.generate"
    static let dismissPath = "/api/dsh-maoxuan-pet.dismiss"
    static let windowWidth: CGFloat = 640
    static let windowHeight: CGFloat = 720
    static let defaults = UserDefaults(suiteName: "dsh-maoxuan-pet.window")!

    static func log(_ message: String) {
        guard verbose else { return }
        FileHandle.standardError.write(Data("[maoxuan-pet] \(message)\n".utf8))
    }

    static func jsonString(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8),
              array.count > 1 else { return "{}" }
        return String(array.dropFirst().dropLast())
    }
}

// MARK: - 无边框窗口要显式声明可成为 key（Escape 关卡片需要键盘事件）

final class PetWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - 点击穿透容器：白名单矩形之外，鼠标事件全部放行给桌面

final class ClickThroughView: NSView {
    weak var webView: WKWebView?
    /// 容器本地坐标（左下原点）；矩形之外 hitTest 返回 nil → 点击落到下层窗口。
    var passRects: [CGRect] = []

    override func hitTest(_ aPoint: NSPoint) -> NSView? {
        let local: NSPoint
        if let superview {
            local = convert(aPoint, from: superview)
        } else {
            local = aPoint
        }
        for rect in passRects where rect.contains(local) {
            return webView
        }
        return nil
    }
}

// MARK: - 主控制器

final class ShellController: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: PetWindow!
    private var webView: WKWebView!
    private var clickView: ClickThroughView!
    private var pollItem: DispatchWorkItem?
    /// ephemeral：无磁盘缓存/cookie，壳不写任何本地数据（也躲开 ~/Library/Caches 权限噪音）
    private lazy var http: URLSession = URLSession(configuration: .ephemeral)
    private var dragBaseOrigin: NSPoint?
    private var pageReady = false
    private var lastInterval: TimeInterval = 20
    /// 精灵图 name → data URL：WebKit 的 ATS 会拦 file:// 页面直挂的 http 图，
    /// 所以素材也由原生层拉取后转 base64 注入，WebKit 全程零网络请求。
    private var spriteDataURLs: [String: String] = [:]
    private var spritePending = Set<String>()

    // MARK 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSRect(x: 0, y: 0, width: Shell.windowWidth, height: Shell.windowHeight)
        let window = PetWindow(
            contentRect: restoredFrame() ?? defaultFrame(),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.isMovableByWindowBackground = false
        window.acceptsMouseMovedEvents = true
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = false

        let container = ClickThroughView(frame: content)
        container.wantsLayer = true

        let configuration = WKWebViewConfiguration()
        // 壳不需要任何网站数据（位置持久化走原生 UserDefaults），用一次性存储免得碰 ~/Library/WebKit
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "pet")
        // __petEnv 必须在页面脚本运行前就位（didFinish 时内联脚本早已执行完）
        let envScript = WKUserScript(
            source: "window.__petEnv = \(Shell.jsonString(["origin": Shell.origin]));",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(envScript)

        let webView = WKWebView(frame: container.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        // WKWebView 画透明底的两件套
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear

        container.webView = webView
        container.addSubview(webView)
        window.contentView = container

        self.window = window
        self.webView = webView
        self.clickView = container

        if let html = locateHTML() {
            webView.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        } else {
            FileHandle.standardError.write(Data("[maoxuan-pet] 找不到 pet.html（应与可执行文件同目录）\n".utf8))
            NSApp.terminate(nil)
            return
        }

        window.orderFrontRegardless()
        FileHandle.standardError.write(Data("[maoxuan-pet] 小毛已站上桌面 — \(Shell.origin)（独立进程，DSH 最小化不影响她）\n".utf8))
    }

    func applicationWillTerminate(_ notification: Notification) {
        persistFrame()
    }

    /// pet.html 与可执行文件同目录（build.sh 负责拷贝）。
    private func locateHTML() -> URL? {
        let argv0 = CommandLine.arguments.first ?? "maoxuan-pet"
        let executable = URL(fileURLWithPath: argv0).resolvingSymlinksInPath()
        let candidate = executable.deletingLastPathComponent().appendingPathComponent("pet.html")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    // MARK 窗口位置

    private func defaultFrame() -> NSRect {
        let visible = NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(
            x: visible.maxX - Shell.windowWidth - 28,
            y: visible.minY + 96
        )
        return NSRect(origin: origin, size: NSSize(width: Shell.windowWidth, height: Shell.windowHeight))
    }

    private func restoredFrame() -> NSRect? {
        guard ProcessInfo.processInfo.arguments.contains("--reset") == false,
              let raw = Shell.defaults.string(forKey: "frame") else { return nil }
        let frame = NSRectFromString(raw)
        let onScreen = NSScreen.screens.contains { $0.visibleFrame.intersects(frame) }
        guard onScreen, frame.width > 100, frame.height > 100 else { return nil }
        return frame
    }

    private func persistFrame() {
        guard let window else { return }
        Shell.defaults.set(NSStringFromRect(window.frame), forKey: "frame")
        Shell.log("frame saved: \(NSStringFromRect(window.frame))")
    }

    private func resetFrame() {
        Shell.defaults.removeObject(forKey: "frame")
        let frame = defaultFrame()
        window.setFrame(frame, display: true)
        persistFrame()
    }

    /// 拖拽落点收敛：至少留 140pt 在可见区域内，防止拖丢。
    private func clampedOrigin(_ origin: NSPoint) -> NSPoint {
        let size = window.frame.size
        let center = NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let clampedX = min(max(origin.x, visible.minX - size.width + 140), visible.maxX - 140)
        let clampedY = min(max(origin.y, visible.minY - size.height + 140), visible.maxY - 40)
        return NSPoint(x: clampedX, y: clampedY)
    }

    // MARK 轮询（原生层负责全部 HTTP，页面不跨域）

    private func schedulePoll(after interval: TimeInterval) {
        pollItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.pollNow() }
        pollItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + interval, execute: item)
    }

    private func pollNow() {
        guard let url = URL(string: Shell.origin + Shell.statePath) else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.httpMethod = "GET"
        http.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    Shell.log("state failed: \(error.localizedDescription)")
                    self.evaluate("window.__petOffline && window.__petOffline();")
                    self.schedulePoll(after: 8)
                    return
                }
                if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    Shell.log("state HTTP \(http.statusCode)")
                    self.evaluate("window.__petOffline && window.__petOffline();")
                    self.schedulePoll(after: 8)
                    return
                }
                guard let data, let text = String(data: data, encoding: .utf8) else {
                    self.evaluate("window.__petOffline && window.__petOffline();")
                    self.schedulePoll(after: 8)
                    return
                }
                // 生成中的话 3s 后紧跟下一条，让气泡尽快落地
                let running = (text.contains("\"running\":true") || text.contains("\"running\" : true"))
                self.lastInterval = running ? 3 : 20
                self.ensureSprites(from: data)
                self.evaluate("window.__petState && window.__petState(\(self.sanitized(text)));")
                self.schedulePoll(after: self.lastInterval)
            }
        }.resume()
    }

    /// 从 state 里拿 pet.sprites，逐张原生拉取并转 data URL 注入页面（一次性，之后命中缓存）。
    private func ensureSprites(from stateData: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: stateData),
              let dict = obj as? [String: Any],
              let pet = dict["pet"] as? [String: Any],
              let sprites = pet["sprites"] as? [String: String] else { return }
        var newlyNeeded: [(name: String, path: String)] = []
        for (name, path) in sprites {
            guard spriteDataURLs[name] == nil, !spritePending.contains(name) else { continue }
            spritePending.insert(name)
            newlyNeeded.append((name, path))
        }
        guard !newlyNeeded.isEmpty else { return }
        for entry in newlyNeeded {
            guard let url = URL(string: Shell.origin + entry.path) else {
                spritePending.remove(entry.name)
                continue
            }
            http.dataTask(with: URLRequest(url: url, timeoutInterval: 8)) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.spritePending.remove(entry.name)
                    if let error {
                        Shell.log("sprite \(entry.name) failed: \(error.localizedDescription)")
                    } else if let http = response as? HTTPURLResponse, http.statusCode == 200, let data {
                        let mime = http.mimeType ?? "image/png"
                        self.spriteDataURLs[entry.name] = "data:\(mime);base64,\(data.base64EncodedString())"
                        Shell.log("sprite \(entry.name) ready (\(data.count) bytes)")
                    }
                    self.evaluate("window.__petSprites && window.__petSprites(\(Shell.jsonString(self.spriteDataURLs)));")
                }
            }.resume()
        }
    }

    /// JSON 文本直接内联为 JS 字面量；U+2028/2029 在旧解析器里会断行，换义掉。
    private func sanitized(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    private func evaluate(_ source: String) {
        guard pageReady else { return }
        webView.evaluateJavaScript(source, completionHandler: { result, error in
            if let error { Shell.log("evaluate failed: \(error.localizedDescription)") }
        })
    }

    // MARK POST 动作（再督促 / 收起）

    private func postAction(path: String, body: String) {
        guard let url = URL(string: Shell.origin + path) else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 200)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body.data(using: .utf8)
        Shell.log("POST \(path) \(body)")
        http.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    Shell.log("POST failed: \(error.localizedDescription)")
                } else if let http = (response as? HTTPURLResponse) {
                    let bodyText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    Shell.log("POST \(path) → \(http.statusCode) \(String(bodyText.prefix(160)))")
                }
                self.evaluate("window.__petActionDone && window.__petActionDone();")
                self.pollNow()
            }
        }.resume()
    }

    // MARK WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        pollNow()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Shell.log("page load failed: \(error.localizedDescription)")
    }

    // MARK WKScriptMessageHandler（页面 → 原生）

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "pet",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "input":
            // 页面上报的可交互矩形（CSS px，左上原点）→ 容器本地坐标（左下原点）
            guard let rects = body["rects"] as? [[String: Any]] else { return }
            let contentHeight = webView.bounds.height
            let converted: [CGRect] = rects.compactMap { dict in
                guard let x = (dict["x"] as? NSNumber)?.doubleValue,
                      let y = (dict["y"] as? NSNumber)?.doubleValue,
                      let w = (dict["w"] as? NSNumber)?.doubleValue,
                      let h = (dict["h"] as? NSNumber)?.doubleValue,
                      w > 0, h > 0 else { return nil }
                return CGRect(x: x, y: contentHeight - (y + h), width: w, height: h)
            }
            clickView.passRects = converted
            Shell.log("input rects: \(converted.count)")

        case "dragstart":
            dragBaseOrigin = window.frame.origin

        case "dragto":
            guard let base = dragBaseOrigin else { return }
            let dx = (body["dx"] as? NSNumber)?.doubleValue ?? 0
            let dy = (body["dy"] as? NSNumber)?.doubleValue ?? 0
            let target = clampedOrigin(NSPoint(x: base.x + dx, y: base.y - dy))
            window.setFrameOrigin(target)

        case "dragend":
            dragBaseOrigin = nil
            persistFrame()

        case "action":
            let action = body["action"] as? String
            if action == "generate" {
                postAction(path: Shell.generatePath, body: "{}")
            } else if action == "dismiss" {
                let raw = body["id"] as? String ?? ""
                let id = String(raw.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
                let payload = id.isEmpty ? "{}" : "{\"id\":\"\(id)\"}"
                postAction(path: Shell.dismissPath, body: payload)
            }

        case "config":
            let action = body["action"] as? String
            if action == "quit" {
                NSApp.terminate(nil)
            } else if action == "reset" {
                resetFrame()
            }

        default:
            break
        }
    }
}

// MARK: - 入口

let arguments = ProcessInfo.processInfo.arguments
var index = 1
while index < arguments.count {
    let argument = arguments[index]
    if argument.hasPrefix("--origin=") {
        var value = String(argument.dropFirst("--origin=".count))
        while value.hasSuffix("/") { value.removeLast() }
        Shell.origin = value
    } else if argument.hasPrefix("--port=") {
        let value = String(argument.dropFirst("--port=".count))
        Shell.origin = "http://127.0.0.1:\(value)"
    } else if argument == "--verbose" {
        Shell.verbose = true
    }
    index += 1
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不占 Dock、不进 Cmd-Tab
let controller = ShellController()
app.delegate = controller
app.run()
