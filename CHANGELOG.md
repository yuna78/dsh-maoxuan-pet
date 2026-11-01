# CHANGELOG

## 0.3.2（2026-11-01）

### 桌宠壳

- **新增：点击真穿透（窗口随内容收缩）**——原 hitTest 白名单只能在 AppKit 层丢事件，WindowServer 已把点击判给壳窗口（640×720 的透明玻璃），后面 App 点不到。曾试过 CGS 窗口形状（`CGSSetWindowShape`）：坐标约定对不上且**连渲染一起裁**（小毛活着但隐形），弃用。最终方案：壳窗口随页面报告的可点区域收缩（右下角锚定，stage 定位固定 ⇒ 小毛纹丝不动），卡片高度与视口解耦（固定 480px）防止窗口伸缩反馈回路；窗口外点击天然直达下层。
- **修复：恢复的窗口位置会把小毛放回屏幕外**——保存的位置 {{1218,-19}} 挂在屏幕右缘外（屏幕 1512pt 宽，窗口右缘 1858pt），她本人活着但站在不可见区域，看起来就是「放出去没了」。现在恢复前校验小毛站立处（窗口右下 220×300）是否整块在屏内，不在就回退默认位置并留日志。
- **新增：跟随宿主换端口**——桌面版重启会换 web 端口，壳还指着旧 origin 就是反复出现的「连接中断」。连续 3 次拉取失败后扫 `$DSH_HOME/agent-tree-dock-*.json`（文件名带端口，取最新），用公开路由探活成功即自动跟随；约 30 秒内自愈。`--token` 模式不自动跟随（token 按次发放），日志提示重新放她到桌面。
- **修复：立绘「下载成功但画面不换装」（蓝色大脑袋）**——立绘/状态注入是单次 `evaluate`，若那一刻 WKWebView 还没加载完 `pet.html`，注入落在即将被丢弃的上下文里，数据永久丢失；而立绘只在下载完成时注入一次，错过就永远停在壳内置占位形象。0.3.1 的 `--public` 模式无鉴权流程、轮询极快，把窗口期放大成必现。现在：注入前先落页面全局 `__petSpriteData` / `__petStateData`（页面脚本就绪时自取），并且壳以页面 rects 上报为「活着」心跳，发现立绘/首份 state 尚未送达就补发——时序无论怎么排都能收敛。新增恒落盘诊断日志 `$DSH_HOME/storages/dsh-maoxuan-pet.shell.log`（256KB 自动截断；宿主按钮拉起时 stdio 被丢弃，这份日志是唯一黑盒透视）。

## 0.3.1 — 2026-11-01

修复：预设面板上 maoxuan-pet 显示「加载失败 / Failed to load」；桌宠壳补上宿主鉴权支持。

### 修复
- **preset 挂载必败的缺参**：`cordis.patch.yml` 里 preset 的 `tool-todo` 子项没有给 `allowParallelInProgress`，而宿主的 `@deepseek-ai/dsh-tool-todo` 从 rc.2 起就把它声明为 **required**（且无默认值可合并）。挂载时校验失败，注册表把该行标记为 `broken`，界面徽章显示「加载失败」，悬停可见原文：`tool-todo (@deepseek-ai/dsh-tool-todo): invalid config: $.allowParallelInProgress missing required value`。现在显式声明 `allowParallelInProgress: false`（本预设一次只推进一件事，与 `false` 语义一致）。
- 用 dsh 0.2.1-rc.5 运行时在真实桌面同构环境里探测过 `agentPresets.list()`：修复前 maoxuan-pet 带 `broken` 字段，修复后消失（dev-assistant 的失败是 dsh-plugin-dev-workflow 自己的 `connection` 注入问题，与本插件无关）。

### 桌宠壳
- **壳不再被宿主鉴权卡死**：DSH `0.2.1-rc.2` 起 Web API 全部要鉴权（launch token 只在 `GET /` 换签名 cookie，`/api/*` 裸请求一律 401，且不接受 Authorization 头），而 token 只有 CLI 宿主会打印、桌面 App 从不外泄——壳此前在桌面 App 旁边永远是「连接中断」。现在两条路：
  - **`--public`（默认推荐）**：插件在 web server 上直接注册一组 loopback 公开路由 `SHELL_ROUTES`（`/dsh-maoxuan-pet/pet.json`、`asset.png`、`generate`、`dismiss`），GET 只读、POST 强制 JSON + `x-dsh-maoxuan-pet: 1` 自定义头（跨站页面发不出来，非 CSRF 洞）、监听只绑 loopback；壳不需要 token 也不需要 cookie，桌面 App 旁边同样满血。可用 `publicRoutes: false` 关闭。
  - **`--token=<TOKEN>`**：给 CLI 宿主用，`GET /?token=…` 换 `dsh-auth-*` 签名 cookie（URLSession 内存 jar、不落盘、遇 401 自动重换）。
- **桌面模式互斥显示（新）**：壳在桌面上时，界面里的小毛自动隐身，右下角只留一枚「小毛在桌面上 · 点此收回」小徽章；收回（或右键壳退出）后界面宠物自动回来。避免「两只小毛同时显示」的困惑。
- **界面开关（新）**：红皮书卡片页脚新增 **「放她到桌面 / 收回桌宠」**——宿主新增第六条路由 `GET|POST /api/dsh-maoxuan-pet.shell`（状态快照 + launch/quit，origin 只接受 `http://127.0.0.1:<port>` 防注入；产物缺失时先自动跑 `desktop/build.sh`，最长 120s）。壳写 pidfile（`$DSH_HOME/storages/dsh-maoxuan-pet.shell.pid`，读取方探活、退出清理）+ 自身单实例保护，手动双击与按钮互相认得，不会叠出两只。已对活宿主端到端验证：GET 状态 → launch 起进程并落 pidfile → 重复 launch 幂等 → quit 退净并清 pidfile。
- **双击备用**：仓库根目录新增 `启动小毛.command`——自动编译（首次）、自动找最近写入的 `~/.dsh/agent-tree-dock-<port>.json` 得到宿主地址、自动 `--public` 起壳，重复双击不会叠出第二只。
- 验证：13091（鉴权过、插件未装：404 非 401）、30888/30891（maoxuan 宿主：`--public` 下 state 200 + 四帧立绘原生拉取、POST 缺头 403 / 带头 200）；`verify/host.test.mjs` 新增 2 条公开路由用例（假 ctx 的 webServer 记录注册 + 走 node 风格 req/res 断言 200/403），全套 20/20。

### 排查备注
- 挂载失败只在客户端读取名册（打开预设面板）时可见，宿主启动日志默认不打印该警告，所以此前一直没暴露。

## 0.3.0 — 2026-11-01

新能力：独立 macOS 桌宠壳——小毛从 DSH 界面里走出来，站到真正的桌面上；DSH 最小化甚至关掉界面，她都站在原地。

### 桌宠壳（`desktop/`）
- **为什么需要它**：Web 宠物是 `position:fixed` 的 DOM，永远画不出浏览器视口之外——DSH 最小化她就没。DSH 自带宠物能「跑出去」，是因为壳层进程建了第二个原生窗口（透明、置顶、跨所有 Space）。本壳用纯 Swift + 系统 WebKit（单文件约 450 行、零第三方依赖）给小毛配了同款独立窗口，进程独立于 DSH。
- **窗口参数对照**（从 DSH Tauri 壳层二进制核实的参数 → 本壳实现）：`transparent`/`alwaysOnTop`/`visibleOnAllWorkspaces`/`skipTaskbar` → 透明无边框 `NSWindow` + `.floating` + `canJoinAllSpaces` + accessory 策略（不占 Dock、不进 Cmd-Tab）；`set_pet_input_region`/`set_pet_ignore_cursor_events` → 容器 `hitTest` 白名单矩形，矩形外鼠标事件全部穿透回桌面。
- **数据通道**：`URLSession`（ephemeral）原生轮询既有同源路由——state 平时 20s、生成中 3s、离线 8s；`再督促`/`收起` POST 同源接口；宿主 `index.js` 零改动，Web 宠物照常并存。
- **素材也走原生层**：WebKit 的 ATS 不认 loopback 豁免，`file://` 页面直挂 `http://127.0.0.1` 的图会被拦（只剩占位鲸），所以精灵图由 URLSession 拉取后转 data URL 注入（`window.__petSprites`）；WebKit 零网络请求，壳零磁盘写入（`nonPersistent` 数据存储 + ephemeral 会话）。
- **交互语义与 Web 宠物一致**：红皮书卡片、新气泡自动弹出、打开 600ms 后标已读、翻书中状态、倒计时标签、`‹ ›` 回翻、Esc 收起；右键小毛 = 复位位置 / 退出；拖小毛或卡片标题栏 = 整窗移动（`screenX/screenY` 差值，无反馈回环），位置存 `UserDefaults`（suite `dsh-maoxuan-pet.window`）跨启动记忆。
- **构建与运行**：`npm run pet:build`（swiftc 约几秒，模块缓存收进项目内）/ `npm run pet`；参数 `--origin=` / `--port=` / `--reset` / `--verbose`；详见 `desktop/README.md`。

### 打包
- `package.json` `files` 收录 `desktop/` 五个源码文件（Info.plist/README/build.sh/maoxuan-pet.swift/pet.html），源码随 npm 包分发；`desktop/build/` 构建产物（二进制 + Swift 模块缓存，约 70MB）不进包体——`.gitignore` 只拦 git 不拦 `npm pack`，files 白名单目录内的产物必须逐文件点名（0.3.0 发布前实测修正）。

## 0.2.3 — 2026-11-01

首次安装修复：模型配置自动从宿主 profile 桥接进 headless 子进程，新装机基本零配置。

### 修复
- **新装机必踩的 `MISSING_CREDENTIAL`**：插件每小时调用 `dsh --profile headless` 生成气泡，而随包 `headless` profile 是一个没有任何模型配置的空壳——官方 DeepSeek、中转线路的用户第一次安装都会生成失败，只能看到「离线摘录 + 报错」。
- 现在**每次生成前自动把宿主 profile patch 里的 llm 条目**（`agent-default-model`、`dsh-llm-pi-ai`、`dsh-llm-deepseek-api-key`）**原样搬到** `$DSH_HOME/storages/dsh-maoxuan-pet.headless-overlay.yml`，并以 `dsh --profile headless --patch <overlay>` 启动子进程：宿主 GUI 能用什么模型（官方 / wocheng 之类任意中转），气泡子进程就能用什么，官方与中转线路零配置可用。
- 待机行为：宿主 patch 没有 llm 条目（如机器确实没配过模型）时不写 overlay，`MISSING_CREDENTIAL` 报错会转成一句可操作的中文指引（保留原始错误摘要）写入 `state.lastError`；`dsh` 找不到（ENOENT）同样给出指引，其他报错原样透传。
- overlay 内容变化才落盘（tmp + rename 原子写）；文件可随时手动删除，插件每次生成都会重写。子进程 llm 桥接失败不影响正常降级。

### 升级行为
- `profile` 配置默认仍是 `headless`。显式改 `profile` / `dshBin` 的老配置完全不受影响（此时不做桥接桥外干扰，`--patch` 只在 overlay 存在时追加）。
- 新增并导出纯函数 `headlessOverlayPath` / `hostPatchPath` / `extractLlmPatchEntries` / `syncHeadlessOverlay` / `friendlyHeadlessError`；`verify/contract.mjs` 增加 llm 抽取与友好报错用例（40 断言全绿）。

## 0.2.2 — 2026-11-01

展示层维护版：README 从技术说明改成安装页，npm 页面的介绍随之更新。

### 文档
- README 开头一句话说清是什么（对齐市场 PR #11067 的条目文案），之后按「安装 → 界面截图 → 四帧立绘 → 能力表 → 配置 → 语料 → 已知限制 → License」排列。
- 删掉架构图、Bubble 字段表、`template × axis` 矩阵、开发验证与踩坑记录；这些只在末尾链到 `docs/` 与 `verify/`。
- 删掉「已知限制」里的立绘生成说明与「逐字可辨」表述；素材记录统一放 `assets/PROVENANCE.md`，版权声明放 `NOTICE`。
- 截图与四帧立绘改用 GitHub raw 绝对地址（npm 页面同样能显示）；`README.en.md` 同步同结构。
- `docs/RELEASE.md` 的当前版本同步到 `0.2.2`。

## 0.2.1 — 2026-11-01

上架插件市场后的首个维护版：图标重做 + 整包瘦身 + 打包门禁补强。

### 图标
- 包内 `assets/icon.svg` 换成「红皮书」造型：米白底、深红书壳、烫金五角星与书名条；按插件面板卡片实际 36px 校过，缩到 36px 仍能读成一本红皮书。
- 新增 `assets/icon-256.png`（256×256 RGBA，17 KB），给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 条目的 `icon:` 用——市场只收 GitHub 托管位图，不收 SVG。

### 体积
- 四帧立绘 640×1348 → 256×539（UI 展示高 132px，2x 屏幕足够）：4 张合计 **2.96 MB → 603 KB**。
- `npm pack` 整包 **4.2 MB → 约 1.2 MB**（59 files），安装与首屏都更快；README / 市场条目用的大图 `docs/screenshot-hero.png` 保留。

### 打包与发布门禁
- `scripts/audit-corpus-coverage.mjs` 迁到 `tools/`：`scripts/` 是开发脚本，不该进 npm 包；全局开源契约检查此前因此 1 项 FAIL，现在是 0 FAIL / 1 WARN（WARN 已由下一条解决）。
- 新增 `prepublishOnly`：发布前自动跑 `verify/smoke.mjs` + `verify/contract.mjs`，防手滑发坏版本。
- `scripts/post-publish-check.mjs`：市场索引有 3.3 MB，超时从 60s 提到 180s（可用 `MARKET_TIMEOUT_MS` 覆盖），慢网下 `--strict` 不再误红。
- 仓库根新增 `screenshots.json`（`["docs/screenshot-hero.png"]`），喂给 dsh-market 详情页的 AppStore 式截图；以后换图只需往本仓 push，不用再来提 PR。

### 文档
- 新增英文 README（`README.en.md`），中文 README 顶部加英文入口。
- README 的资产尺寸、审计脚本路径同步更新；`assets/PROVENANCE.md` 记录交付尺寸与图标改版。

## 0.2.0 — 2026-11-01

首个公开版本。

### 宠物与气泡
- 悬浮宠物「鲸鱼娘·小毛」：4 帧立绘（idle / talk / blink / read），Web `shell.overlay` 渲染，可拖拽、位置本地记忆。
- 红皮书气泡：深红封面 + 烫金书脊 + 米白内文；卡片绝对定位在宠物左侧，开合不移动宠物（宠物贴左边缘时自动翻到右侧）。
- 打开即已读：卡片显示的那一刻才标已读，右上角未读数随之消失；正在读的那条会被钉住，不会被新数据替换。
- 全部已读后仍停在上一次产出，`‹ ›` 可往回翻历史。
- 定时生成的新气泡自动弹出；手动关闭后不会自己重开。
- `收起` / `再督促` 为纯文字按钮；滚动条为烫金滑块 + 深红轨道。

### 内容
- 单条气泡 = 引文 + 一句督促 + 启示，**合计 ≤200 字**（`fitLesson` 保证）。
- 三种取材模板轮转：`quote` 金句 / `excerpt` 文章节选（逐字整句）/ `summary` 小毛概括；游标 `templateCursor` 落盘，不因历史条数封顶而卡住。
- 启示落点六选一：客户 / 项目 / 组织 / 现金流 / 决策 / 自律；「人事」已按用户裁决改名为「组织」，旧状态文件读取时自动迁移。
- 反编造：`quote`/`excerpt` 必须逐字命中语料全文（`isVerbatim`，去空白兜底），否则降级为 `summary`；`summary` 永不回退成篇名。
- 模型复述原文的 `pua` 会被识别（≥8 字公共串）并整条丢弃。
- 无凭据 / 超时 / 非 JSON 时降级为本地摘录，UI 在页脚标注「离线摘录」，不冒充模型生成。

### Host
- 5 条同源路由：`state` / `generate` / `dismiss` / `asset` / `corpus`；状态文件原子写（`.tmp` + `rename`）。
- 每小时生成一次，支持 `quietHours`、`everySeconds`、`maxBubbles`、`headless` 开关与子进程超时；并发手动触发时同步抢占 in-flight 位。
- 运行时把 `corpus/` 注册为 `maoxuan-vademecum` skill，preset `maoxuan-pet`（毛选创业参谋）= persona + skill + 工具。

### 语料与素材
- 33 篇毛选全文（中文马克思主义文库公开电子文本），`corpus/index.json` 记录 `sourceUrl` 与版本；`verified: true` 的条目才参与轮转。
- 语料覆盖审计：`node scripts/audit-corpus-coverage.mjs`（金句逐字命中 33/33，节选可用 32/33）。

### 验证
- `verify/smoke.mjs`（24 项）、`verify/contract.mjs`（38 项）、`verify/host.test.mjs`（18 项）：不联网、不起子进程、不花模型调用。
- 真实环境做过 headless 生成 + headless Chrome/CDP 页面断言（宠物坐标不变、卡片在左、chip 暖色、按钮无盒、已读徽标消失、无未读仍有内容）。

### 已知限制
- 只支持 Web 界面（`dsh.client.platform: web`）。
- 定时器只在 `dsh web` 进程存活时运行，进程停掉不补跑。
- 每次生成是独立的 headless 会话，不共享上下文；用最近 6 条督促避免重复。
