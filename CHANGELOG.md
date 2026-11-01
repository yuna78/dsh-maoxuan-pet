# CHANGELOG

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
