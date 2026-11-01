# 桌面壳：让小毛跑出 DSH 窗口（macOS）

DSH 自带宠物之所以能「跑出去」，是因为它**根本不在网页里**——壳层 Rust 进程建了第二个
原生窗口（透明、置顶、跨所有 Space）。网页（无论浏览器还是 iframe）永远画不出视口之外，
这是浏览器沙箱的硬边界。

本目录给「鲸鱼娘·小毛」配了一个**独立的原生壳**：进程独立于 DSH，DSH 主窗口最小化、
甚至 Web 界面整个关掉，她都站在桌面上。毛选的灵魂（每小时一篇的 headless 生成）
仍由 `index.js` 宿主插件负责，壳只是把「显示器」搬了出来。

## 架构

```
┌─ DSH 宿主（照旧，什么都不用改） ─────────────┐
│ index.js 插件：每小时 headless 读毛选 →     │
│ GET  /api/dsh-maoxuan-pet.state             │
│ POST /api/dsh-maoxuan-pet.generate|dismiss  │
│ GET  /api/dsh-maoxuan-pet.asset?name=…      │
└──────────────┬──────────────────────────────┘
               │  URLSession 原生轮询（绕开 WKWebView 跨域）
┌──────────────┴──────────────────────────────┐
│ maoxuan-pet（独立 Swift 进程）               │
│ · 透明无边框 NSWindow，.floating 置顶，      │
│   canJoinAllSpaces（所有桌面/全屏旁可见）    │
│ · WKWebView 渲染 pet.html（宠物+红皮书卡片） │
│ · hitTest 白名单矩形 = 点击穿透              │
│   （等价 dsh-tauri 的 set_pet_input_region） │
│ · 拖拽/位置持久化/右键菜单/退出              │
└─────────────────────────────────────────────┘
```

对照 DSH 自带宠物窗口（从壳层二进制里核实到的参数）：
`transparent` / `alwaysOnTop` / `visibleOnAllWorkspaces` / `skipTaskbar` /
`set_pet_input_region` / `set_pet_ignore_cursor_events` / 位置持久化到 store——
本壳一一对应，只是把宿主从 Tauri 换成了一个几十 KB 的独立进程。

## 构建与运行

```sh
npm run pet:build      # swiftc 编译（约几秒，产物 desktop/build/maoxuan-pet）
npm run pet            # 编译并前台运行（Ctrl-C 或右键小毛→退出）
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--origin=URL` | 宿主地址，默认 `http://127.0.0.1:3081` |
| `--port=N` | 等价 `--origin=http://127.0.0.1:N` |
| `--public` | **推荐**：走插件注册的 cookie-less 公开路由（`/dsh-maoxuan-pet/…`），不需要 token |
| `--token=TOKEN` | 备选：宿主 launch token，先换签名 cookie 再走 `/api` |
| `--reset` | 忽略保存的位置，回到屏幕右下 |
| `--verbose` | 向 stderr 打轮询/POST/输入区日志 |

无 Dock 图标、不进 Cmd-Tab（`NSActivationPolicy.accessory`）。窗口位置存在
`UserDefaults`（suite `dsh-maoxuan-pet.window`），拖到哪儿下次就在哪儿。

## 鉴权（DSH 0.2.1-rc.2+ 宿主必读）

从 DSH `0.2.1-rc.2` 起宿主 Web API 全部要鉴权：launch token 只在 `GET /` 换签名
cookie（`dsh-auth-*`），`/api/*` 不带 cookie 一律 401，也不接受 Authorization 头。
而 token 只有 CLI 宿主（`dsh web`）会打印，桌面 App 从不外泄——所以壳不能只依赖 `/api`。

本插件因此自己开了一组 **loopback 公开路由**（`SHELL_ROUTES`，默认开启）：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-maoxuan-pet/pet.json` | GET | 与 `/api/dsh-maoxuan-pet.state` 同一份快照 |
| `/dsh-maoxuan-pet/asset.png?name=idle` | GET | 立绘（idle/talk/blink/read） |
| `/dsh-maoxuan-pet/generate` | POST | 同「再督促」（要 `x-dsh-maoxuan-pet: 1` 头） |
| `/dsh-maoxuan-pet/dismiss` | POST | 同「收起」（要 `x-dsh-maoxuan-pet: 1` 头） |

安全性：监听只绑 loopback，公网到不了；GET 只有毛选快照与立绘；POST 强制 JSON
content-type + 自定义头，跨站页面发不出这样的请求（需要 CORS 预检），因此不是 CSRF 洞。
不需要时可用 `publicRoutes: false` 在插件配置里关掉。

两条路怎么选：

- **`--public`（默认推荐）**：不需要 token，桌面 App 旁边也能满血。
- **`--token=<TOKEN>`**：CLI 宿主会打印 `dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`，
  复制给壳即可；壳用它换签名 cookie 后走 `/api`（cookie 失效会自动重换）。

日常最省事：双击仓库根目录的 `启动小毛.command`——它自动找最近一次写入的
`~/.dsh/agent-tree-dock-<port>.json` 得到宿主地址，然后用 `--public` 起壳。

## 界面开关（不用双击）

打开 Web 界面里小毛的红皮书卡片，页脚有 **「放她到桌面」/「收回桌宠」** 按钮：
宿主插件通过 `POST /api/dsh-maoxuan-pet.shell` 拉起/结束本进程（见 `docs/API-CONTRACT.md`）。
状态读 pidfile，所以无论壳是按钮起的还是双击 `启动小毛.command` 起的，按钮都认得出；
壳自己还有单实例保护（已有活着的实例时新实例直接退出），不会叠出两只。

## 交互

- **点小毛**：开合红皮书卡片；新气泡照样自动弹出、600ms 后自动标记已读——与 web 版同语义。
- **拖小毛或卡片标题栏**：整窗移动；原地松手才算点击（>4px 判定为拖拽）。
- **右键小毛**：复位位置 / 退出小毛。
- **Esc**：收起卡片。
- 宿主不在时：圆点变红、卡片内提示「连接中断，重试中…」，人继续站着。

## 已知边界

- 仅 macOS（用系统 WebKit，零第三方依赖）。Windows/Linux 想要同款，
  照 `docs/` 里 dsh-tauri 的窗口参数用 Tauri 2 或 Electron 起一个同样的壳即可，
  页面（pet.html）不用改——它只依赖 `__petState/__petSprites/__petOffline/__petActionDone`
  几个注入点和 `webkit.messageHandlers.pet` 一个消息通道。
- **精灵图走原生层转 data URL**：WebKit 的 ATS 不认 loopback 豁免，
  `file://` 页面直挂 `http://127.0.0.1` 的图会被拦（表现为只剩占位鲸），
  所以素材由 URLSession 拉取后 base64 注入，WebKit 全程零网络请求。
- 宿主关掉后她只是「待机」并不会死——离线轮询 8s 一次，开销可忽略。
- 本壳不上传任何东西；全部数据都来自本机 harness 端口。
