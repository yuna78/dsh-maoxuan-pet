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
| `--reset` | 忽略保存的位置，回到屏幕右下 |
| `--verbose` | 向 stderr 打轮询/POST/输入区日志 |

无 Dock 图标、不进 Cmd-Tab（`NSActivationPolicy.accessory`）。窗口位置存在
`UserDefaults`（suite `dsh-maoxuan-pet.window`），拖到哪儿下次就在哪儿。

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
