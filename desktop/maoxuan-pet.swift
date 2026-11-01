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
// 用法：maoxuan-pet [--origin=http://127.0.0.1:3081 | --port=3081] [--token=… | --public] [--reset] [--verbose]
//       --token= 宿主 launch token（dsh web 启动日志 URL 里的 ?token=…）；开了鉴权的宿主（0.2.1-rc.2+）
//       必须带，否则 API 全 401。先用它 GET /?token= 换签名 cookie，之后所有请求自动携带。
//       --public 走插件自己的 loopback 公开路由（/dsh-maoxuan-pet/…）：不需要 token，
//       桌面 App（不打印 token）旁边也能满血——这是日常推荐用法。
// 退出：右键小毛 → 退出小毛。

import AppKit
import WebKit


// MARK: - 配置

enum Shell {
    static var origin = "http://127.0.0.1:3081"
    static var verbose = false
    /// 宿主 launch token（`dsh web` 启动时打印在 URL 的 ?token=…）。给了 token 就先走一次
    /// `GET /?token=` 换回签名 cookie（dsh-auth-*，绑定 127.0.0.1:端口，30 天），之后
    /// state/sprite/POST 全部自带 cookie——0.2.1-rc.2 起宿主 API 有鉴权，无 cookie 一律 401。
    static var token: String?
    /// 公开路由模式（`--public`）：走插件注册的 loopback 公开路由（/dsh-maoxuan-pet/…），
    /// 不要 token、不要 cookie。宿主的 /api 有鉴权且拿不到 launch token 时（典型：桌面 App）
    /// 用这个。POST 仍带 `x-dsh-maoxuan-pet: 1` 头，宿主据此拒绝跨站请求。
    static var publicRoutes = false
    static var statePath = "/api/dsh-maoxuan-pet.state"
    static var generatePath = "/api/dsh-maoxuan-pet.generate"
    static var dismissPath = "/api/dsh-maoxuan-pet.dismiss"
    static var assetPath = "/api/dsh-maoxuan-pet.asset"
    static let windowWidth: CGFloat = 640
    static let windowHeight: CGFloat = 720
    static let defaults = UserDefaults(suiteName: "dsh-maoxuan-pet.window")!

    static func log(_ message: String) {
        let line = "[maoxuan-pet] \(message)\n"
        if verbose {
            FileHandle.standardError.write(Data(line.utf8))
        }
        // 恒落文件：按钮拉起的壳 stdio 被宿主丢弃（stdio: 'ignore'），
        // 没有这份日志，出问题就是黑盒。256KB 自动截断。
        Self.appendToFile(line)
    }

    /// 高频日志（每秒多次的 input rects 等）只进 stderr，不刷文件。
    static func debug(_ message: String) {
        guard verbose else { return }
        FileHandle.standardError.write(Data("[maoxuan-pet] \(message)\n".utf8))
    }

    /// 关键诊断恒落一份到文件：按钮拉起的壳 stdio 被宿主丢弃（stdio: 'ignore'），
    /// 没有这份日志，出问题就是黑盒。超过 256KB 从头截断，避免无限增长。
    private static func appendToFile(_ line: String) {
        let home = ProcessInfo.processInfo.environment["DSH_HOME"] ?? NSHomeDirectory() + "/.dsh"
        let path = home + "/storages/dsh-maoxuan-pet.shell.log"
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let stamped = "[" + formatter.string(from: Date()) + "] " + line
        guard let data = stamped.data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let size = attrs[.size] as? NSNumber, size.intValue > 262_144 {
                try? handle.truncate(atOffset: 0)
            }
            try? handle.seekToEndOfFile()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            FileManager.default.createFile(atPath: path, contents: data)
        }
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
    /// ephemeral：无磁盘缓存，壳不写任何本地数据（也躲开 ~/Library/Caches 权限噪音）。
    /// cookie 用内存 jar：--token 换回的 dsh-auth cookie 存在这里，每个请求自动携带，
    /// 进程退出即消失，不落盘。
    private lazy var httpConfig: URLSessionConfiguration = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        return configuration
    }()
    private lazy var http: URLSession = URLSession(configuration: httpConfig)
    private var dragBaseOrigin: NSPoint?
    private var pageReady = false
    private var lastInterval: TimeInterval = 20
    /// 精灵图 name → data URL：WebKit 的 ATS 会拦 file:// 页面直挂的 http 图，
    /// 所以素材也由原生层拉取后转 base64 注入，WebKit 全程零网络请求。
    private var spriteDataURLs: [String: String] = [:]
    /// 页面就绪回放：WKWebView 加载完成前 evaluate 会落在将被丢弃的上下文里
    /// （立绘/状态一次性注入从此丢失，页面永远停在占位形象）。页面第一次上报
    /// rects 即「活着」，此时把手里已有的 state 与立绘重放一次，时序就无关紧要了。
    private var replayedSpriteCount = 0
    private var consecutiveFailures = 0
    private var everSucceeded = false
    private var rediscoveryCooldown = Date.distantPast
    private var rediscoverHintShown = false
    private var lastRegionDesc = ""
    /// 穿透问题的釜底抽薪：窗口收缩到只有小毛（+展开的卡片）那么大，
    /// 挡住后面 App 的区域天然就只有那一块——不用任何私有 API，渲染永远完整。
    /// 右下角锚定缩放：stage 定位 right:44 bottom:56 固定，小毛本人纹丝不动。
    private func syncWindowFrame(to union: CGRect) {
        guard let window, union.width > 0 else { return }
        // 只用 union 的「尺寸」、不用它的「位置」：位置随窗口高度 relayout 漂移，
        // 尺寸稳定——这样窗口缩放没有反馈回路。右下角锚定 + stage right:44
        // bottom:56 固定 ⇒ 小毛的屏幕位置纹丝不动。
        let pad: CGFloat = 14
        let width = max(union.width + 44 + pad, 160)
        let height = max(union.height + 56 + pad, 220)
        let frame = window.frame
        guard abs(frame.width - width) > 1 || abs(frame.height - height) > 1 else { return }
        window.setFrame(NSRect(x: frame.maxX - width, y: frame.minY, width: width, height: height), display: true)
        Shell.log("window → \(Int(width))x\(Int(height)) @右下角锚定")
    }


    /// 宿主重启会换端口，壳却还指着旧 origin——这正是「连接中断」反复出现的原因。
    /// 连续失败后扫 ~/.dsh/agent-tree-dock-*.json（文件名带端口，取最新修改的那个），
    /// 用公开路由探活成功就跟随过去。--token 模式不自动跟随（token 是按次发放的）。
    private func tryRediscover() {
        guard Shell.token == nil else {
            if !rediscoverHintShown {
                rediscoverHintShown = true
                Shell.log("宿主可能换了端口；token 模式不自动跟随——请点「收回」后重新放她到桌面")
            }
            return
        }
        let home = ProcessInfo.processInfo.environment["DSH_HOME"] ?? NSHomeDirectory() + "/.dsh"
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: home) else { return }
        let newest = names
            .filter { $0.hasPrefix("agent-tree-dock-") && $0.hasSuffix(".json") }
            .compactMap { name -> (port: String, mtime: Date)? in
                guard let start = name.range(of: "agent-tree-dock-")?.upperBound,
                      let end = name.range(of: ".json")?.lowerBound, start < end else { return nil }
                let port = String(name[start..<end])
                let path = home + "/" + name
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
                      let mtime = attrs[.modificationDate] as? Date else { return nil }
                return (port, mtime)
            }
            .max { $0.mtime < $1.mtime }
        guard let newest, let port = Int(newest.port), (1024..<65536).contains(port) else { return }
        let candidate = "http://127.0.0.1:\(port)"
        guard candidate != Shell.origin, let url = URL(string: candidate + Shell.statePath) else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpMethod = "GET"
        http.dataTask(with: request) { [weak self] _, response, _ in
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            DispatchQueue.main.async {
                guard let self, Shell.origin != candidate else { return }
                Shell.log("DSH 换了端口 → 跟随 \(candidate)（公开路由探活 200）")
                Shell.origin = candidate
                self.consecutiveFailures = 0
                self.pollNow()
            }
        }.resume()
    }
    private var stateReplayed = false
    private var lastStateJSON: String?
    private var spritePending = Set<String>()
    private var authed = false
    private var authInFlight = false

    // MARK 壳的单实例与 pidfile

    /// pidfile：让宿主插件（界面里的开关）认得出「壳是否活着」，包括手动起的。
    /// 崩溃留下的陈旧 pid 由读取方用 kill(pid,0) 探活过滤，不依赖正常退出清理。
    private func pidFilePath() -> String {
        let home = ProcessInfo.processInfo.environment["DSH_HOME"] ?? NSHomeDirectory() + "/.dsh"
        return home + "/storages/dsh-maoxuan-pet.shell.pid"
    }

    private func readLivePid() -> Int32? {
        guard let raw = try? String(contentsOfFile: pidFilePath(), encoding: .utf8),
              let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 else { return nil }
        guard kill(pid, 0) == 0 else { return nil }
        // pid 会被系统复用：文件里的编号活着 ≠ 还是我们的小毛。校验进程身份。
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(MAXPATHLEN)) > 0,
              String(cString: buffer).hasSuffix("maoxuan-pet") else { return nil }
        return pid
    }

    private func writePid() {
        let path = pidFilePath()
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? String(ProcessInfo.processInfo.processIdentifier.description)
            .write(toFile: path, atomically: true, encoding: .utf8)
    }

    private func clearPid() {
        try? FileManager.default.removeItem(atPath: pidFilePath())
    }

    // MARK 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 单实例：屏幕上已经有一只就不重复出来（宿主开关和手动双击都可能触发）
        if let existing = readLivePid(), existing != ProcessInfo.processInfo.processIdentifier {
            FileHandle.standardError.write(Data("[maoxuan-pet] 已有一只小毛在跑（pid \(existing)），这次就不重复出现了\n".utf8))
            exit(0)
        }
        writePid()
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

        // 被谁杀的要有案底：SIGTERM/SIGINT/SIGHUP 落日志再走（SIGKILL 无法捕获）。
        for name in [SIGTERM, SIGINT, SIGHUP] {
            signal(name) { code in
                Shell.log("收到信号 \(code)，退出")
                exit(0)
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let start = Date()
            Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
                Shell.log("heartbeat up=\(Int(-start.timeIntervalSinceNow))s origin=\(Shell.origin)")
            }
        }

        if let html = locateHTML() {
            webView.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        } else {
            FileHandle.standardError.write(Data("[maoxuan-pet] 找不到 pet.html（应与可执行文件同目录）\n".utf8))
            NSApp.terminate(nil)
            return
        }

        window.orderFrontRegardless()
        let authNote: String
        if Shell.publicRoutes { authNote = "，公开路由模式（不需要 token）" }
        else if Shell.token != nil { authNote = "，带 launch token（自动换 dsh-auth cookie）" }
        else { authNote = "，无 token（宿主开鉴权时会是离线模式）" }
        FileHandle.standardError.write(Data("[maoxuan-pet] 小毛已站上桌面 — \(Shell.origin)\(authNote)（独立进程，DSH 最小化不影响她）\n".utf8))
        Shell.log("started pid=\(ProcessInfo.processInfo.processIdentifier) ppid=\(getppid()) origin=\(Shell.origin) auth=\(Shell.token == nil ? "public" : "token")")
    }

    func applicationWillTerminate(_ notification: Notification) {
        clearPid()
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
        guard frame.width > 100, frame.height > 100 else { return nil }
        // 小毛站在窗口右下角（stage right:44 bottom:56）：那一块必须在屏内。
        // 只判「窗口与屏幕相交」会恢复出人在屏外的幽灵窗口——看起来就是丢了。
        let petCorner = NSRect(x: frame.maxX - 220, y: frame.minY, width: 220, height: 300)
        guard NSScreen.screens.contains(where: { $0.visibleFrame.intersection(petCorner) == petCorner }) else {
            Shell.log("保存的位置会让小毛站在屏幕外（\(NSStringFromRect(frame))），改用默认位置")
            return nil
        }
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

    /// 用 launch token 换签名 cookie：`GET /?token=…` → 303 + Set-Cookie（dsh-auth-*，
    /// Max-Age 30 天，绑定 127.0.0.1:端口）。与浏览器打开 GUI 走的是同一条路；cookie 落在
    /// URLSession 内存 jar 里，之后的 state / sprite / POST 每个请求自动携带。
    /// token 来源：`dsh web`（CLI 宿主）启动日志第一行；桌面 App 不打印，拿不到就只能离线模式。
    private func authenticate(_ token: String) {
        if authInFlight { return }
        authInFlight = true
        guard var components = URLComponents(string: Shell.origin + "/") else {
            authInFlight = false
            return
        }
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else {
            authInFlight = false
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.httpMethod = "GET"
        Shell.log("auth: 用 launch token 换 cookie…")
        http.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.authInFlight = false
                if let error {
                    Shell.log("auth failed: \(error.localizedDescription)")
                    self.evaluate("window.__petOfflineSeen=true;if (window.__petOffline) window.__petOffline();")
                    self.schedulePoll(after: 30)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let jar = self.httpConfig.httpCookieStorage
                let hasAuthCookie = jar?.cookies?.contains { $0.name.hasPrefix("dsh-auth-") } ?? false
                guard (200..<400).contains(status), hasAuthCookie else {
                    Shell.log("auth HTTP \(status)，没换到 dsh-auth cookie——token 要来自同一个宿主进程（dsh web 启动日志里的 ?token=）")
                    self.evaluate("window.__petOfflineSeen=true;if (window.__petOffline) window.__petOffline();")
                    self.schedulePoll(after: 30)
                    return
                }
                self.authed = true
                Shell.log("auth ok：dsh-auth cookie 已入 jar，开始拉取 state")
                self.pollNow()
            }
        }.resume()
    }

    private func schedulePoll(after interval: TimeInterval) {
        pollItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.pollNow() }
        pollItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + interval, execute: item)
    }

    private func pollNow() {
        if let token = Shell.token, !authed {
            authenticate(token)
            return
        }
        guard let url = URL(string: Shell.origin + Shell.statePath) else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.httpMethod = "GET"
        http.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    Shell.log("state failed: \(error.localizedDescription)")
                    self.evaluate("window.__petOfflineSeen=true;if (window.__petOffline) window.__petOffline();")
                    self.consecutiveFailures += 1
                    if self.consecutiveFailures >= 3 || (self.consecutiveFailures >= 1 && !self.everSucceeded), Date() >= self.rediscoveryCooldown {
                        self.rediscoveryCooldown = Date().addingTimeInterval(20)
                        self.tryRediscover()
                    }
                    self.schedulePoll(after: 8)
                    return
                }
                if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    let snippet = String(data: (data ?? Data()).prefix(160), encoding: .utf8) ?? "-"
                    Shell.log("state HTTP \(http.statusCode) url=\(url.absoluteString) body=\(snippet)")
                    self.evaluate("window.__petOfflineSeen=true;if (window.__petOffline) window.__petOffline();")
                    // 401 = jar 里的 cookie 失效了（宿主重启换了 launch token、或 30 天过期）：
                    // 置回未鉴权，下一轮先用 --token 重新换一次 cookie 再拉。
                    if http.statusCode == 401, Shell.token != nil { self.authed = false }
                    self.consecutiveFailures += 1
                    if self.consecutiveFailures >= 3 || (self.consecutiveFailures >= 1 && !self.everSucceeded), Date() >= self.rediscoveryCooldown {
                        self.rediscoveryCooldown = Date().addingTimeInterval(20)
                        self.tryRediscover()
                    }
                    self.schedulePoll(after: 8)
                    return
                }
                guard let data, let text = String(data: data, encoding: .utf8) else {
                    self.evaluate("window.__petOfflineSeen=true;if (window.__petOffline) window.__petOffline();")
                    self.schedulePoll(after: 8)
                    return
                }
                self.consecutiveFailures = 0
                self.everSucceeded = true
                // 生成中的话 3s 后紧跟下一条，让气泡尽快落地
                let running = (text.contains("\"running\":true") || text.contains("\"running\" : true"))
                self.lastInterval = running ? 3 : 20
                self.ensureSprites(from: data)
                let payload = self.sanitized(text)
                self.lastStateJSON = payload
                self.evaluate("window.__petStateData=\(payload);if (window.__petState) window.__petState(window.__petStateData);")
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
            // 公开路由模式下 state 里的 sprite 路径仍是 /api/…，换到公开素材路由
            let path = Shell.publicRoutes
                ? entry.path.replacingOccurrences(of: "/api/dsh-maoxuan-pet.asset", with: "/dsh-maoxuan-pet/asset.png")
                : entry.path
            guard let url = URL(string: Shell.origin + path) else {
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
                    self.evaluate("window.__petSpriteData=\(Shell.jsonString(self.spriteDataURLs));if (window.__petSprites) window.__petSprites(window.__petSpriteData);")
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
        // 公开路由的 POST 要求这个头（跨站页面发不出来，宿主据此挡 CSRF）；/api 模式忽略它
        request.setValue("1", forHTTPHeaderField: "x-dsh-maoxuan-pet")
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
            // 原始页面坐标（top-left）正是 CGS 形状要的坐标系
            let raw: [CGRect] = rects.compactMap { dict in
                guard let x = (dict["x"] as? NSNumber)?.doubleValue,
                      let y = (dict["y"] as? NSNumber)?.doubleValue,
                      let w = (dict["w"] as? NSNumber)?.doubleValue,
                      let h = (dict["h"] as? NSNumber)?.doubleValue,
                      w > 0, h > 0 else { return nil }
                return CGRect(x: x, y: y, width: w, height: h)
            }
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
            Shell.debug("input rects: \(converted.count)")
            // 可点区域的并集写进日志：用户体感「隐形区域大」时，拿这行对账
            let union = converted.reduce(CGRect.null) { $0.union($1) }
            syncWindowFrame(to: union)
            let desc = String(format: "input region: x=%.0f y=%.0f w=%.0f h=%.0f（窗口 %.0fx%.0f）",
                              union.minX, union.minY, union.width, union.height,
                              webView.bounds.width, webView.bounds.height)
            if desc != lastRegionDesc {
                lastRegionDesc = desc
                Shell.log(desc)
            }
            // 页面就绪补发：立绘/首份 state 可能比页面加载完成更晚/更早到达，
            // 一次性 evaluate 会落在将被丢弃的上下文里。rects 是页面「活着」的
            // 心跳，数据比上次补发多就再补一轮——最终一定补齐。
            if !stateReplayed, let payload = lastStateJSON {
                stateReplayed = true
                self.evaluate("window.__petStateData=\(payload);if (window.__petState) window.__petState(window.__petStateData);")
                Shell.log("page ready → 补发 state")
            }
            if spriteDataURLs.count > replayedSpriteCount {
                replayedSpriteCount = spriteDataURLs.count
                self.evaluate("window.__petSpriteData=\(Shell.jsonString(spriteDataURLs));if (window.__petSprites) window.__petSprites(window.__petSpriteData);")
                Shell.log("page ready → 补发立绘 \(replayedSpriteCount) 张")
            }

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
    } else if argument.hasPrefix("--token=") {
        // 容错：允许把「?token=xxx」整段或「token=xxx」一起粘进来
        var value = String(argument.dropFirst("--token=".count)).trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("token=") { value = String(value.dropFirst("token=".count)) }
        while value.hasSuffix("/") { value.removeLast() }
        Shell.token = value.isEmpty ? nil : value
    } else if argument == "--public" {
        Shell.publicRoutes = true
    } else if argument == "--verbose" {
        Shell.verbose = true
    }
    index += 1
}

if Shell.publicRoutes {
    Shell.statePath = "/dsh-maoxuan-pet/pet.json"
    Shell.generatePath = "/dsh-maoxuan-pet/generate"
    Shell.dismissPath = "/dsh-maoxuan-pet/dismiss"
    Shell.assetPath = "/dsh-maoxuan-pet/asset.png"
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不占 Dock、不进 Cmd-Tab
let controller = ShellController()
app.delegate = controller
app.run()
