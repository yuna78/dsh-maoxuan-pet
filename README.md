# 鲸鱼娘 · 小毛 —— 每小时陪你读一篇毛选的桌宠，macOS 上还能站上真正的桌面

红皮书气泡 + 四帧立绘；每条内容 = 原文引文（带来源日期）＋ 一句说给你听的督促 ＋ 一条能当天验证的启示，整条 ≤ 200 字。

## 安装

```bash
dsh plugin --profile web add dsh-plugin-maoxuan-pet
```

装完按 **Ctrl+C 停掉 `dsh web`，再重新 `dsh web`**，刷新页面——右下角就有小毛了。

- 要求：DSH `>=0.2.1-rc.2 <0.3.0`、Node `^22.19.0 || >=24.0.0`，仅 Web 界面；
- 从源码安装、卸载、排错：[docs/INSTALL.md](docs/INSTALL.md)。

## 让她站上真正的桌面（macOS，可选）

Web 宠物住在 DSH 界面里，界面最小化她就跟着没了——这是浏览器沙箱的硬边界。`desktop/` 目录自带一个**独立进程的桌宠壳**（纯 Swift + 系统 WebKit，约 450 行、零依赖）：透明、置顶、跨所有桌面空间，DSH 最小化甚至关掉界面她都站着；毛选的灵魂（每小时读一篇）仍由插件负责，壳只把「显示器」搬了出来。

**最省事：不用碰终端。** 打开小毛的红皮书卡片，页脚有一个 **「放她到桌面」** 按钮——点她一下，小毛就以独立窗口站上桌面（首次会自动编译，几秒）；再点一次「收回桌宠」她就回界面里。不需要 token，不需要双击任何文件。

两条备用路：

- 双击仓库根目录的 `启动小毛.command`（自动连当前 DSH、自动 `--public`，重复双击不会叠出第二只）；
- 命令行：`./desktop/build/maoxuan-pet --public`。

点她开合红皮书卡片、拖她换位置（下次还在那儿、能拖出 DSH 窗口）、右键她 = 复位位置 / 退出。详见 [desktop/README.md](desktop/README.md)。

> Windows / Linux：界面里的宠物照常可用，但「拖出窗口」的独立壳目前只有 macOS 实现；页面 `pet.html` 与路由是跨平台的，照 `desktop/README.md` 用 Tauri/Electron 包一层即可。

## 界面

![红皮书气泡](https://raw.githubusercontent.com/yuna78/dsh-maoxuan-pet/main/docs/screenshot-hero.png)

深红封面 + 烫金书脊的气泡挂在宠物左边，宠物自己不动；打开即已读（右上角未读数消失），`‹ ›` 可以往回翻历史，`收起` / `再督促` 是纯文字按钮。整点生成的新气泡会自己弹出来。

## 小毛

| 站着 | 说话 | 眨眼 | 看书 |
|:--:|:--:|:--:|:--:|
| ![idle](https://raw.githubusercontent.com/yuna78/dsh-maoxuan-pet/main/assets/pet-idle.png) | ![talk](https://raw.githubusercontent.com/yuna78/dsh-maoxuan-pet/main/assets/pet-talk.png) | ![blink](https://raw.githubusercontent.com/yuna78/dsh-maoxuan-pet/main/assets/pet-blink.png) | ![read](https://raw.githubusercontent.com/yuna78/dsh-maoxuan-pet/main/assets/pet-read.png) |

四帧切换时身体不跳（共用同一画布与脚底线）。民间同人设定，与 DeepSeek 官方无关。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **每小时读一篇** | 内置 33 篇毛选公开语料，轮转挑一篇没刚读过的；`quote` 金句 / `excerpt` 节选 / `summary` 小毛概括 三种模板轮转 |
| **不编造原文** | `quote` / `excerpt` 必须逐字命中语料全文，不命中就降级成 `summary`；模型复述原文会被识别并整条丢弃 |
| **六个落点** | 客户 / 项目 / 组织 / 现金流 / 决策 / 自律——每次只给一个，配「一条硬规则 + 怎么验证」 |
| **能追问** | 自带 `maoxuan-pet`（毛选创业参谋）preset 与 `maoxuan-vademecum` skill，可开新会话问「根据毛选，我这一步该怎么走」 |
| **不打扰** | 免打扰时段（默认 02:00–08:00）、每日上限（默认 24 条）、位置本地记忆、已读才消徽标、`‹ ›` 可回翻 |
| **掉线也不空转** | 无凭据 / 超时 / 非 JSON 时降级为本地摘录，并在页脚标注「离线摘录」，不冒充模型生成 |

## 配置

```yaml
- id: dsh-maoxuan-pet
  config:
    enabled: true
    everySeconds: 3600      # 每小时
    firstDelaySeconds: 90   # 启动后 90s 先来一次
    quietHours: [2, 8]      # 本地时间 02:00–08:00 不打扰
    dailyLimit: 24          # 每天最多生成次数（防失控）
    maxBubbles: 40
    headless: true          # false = 只用本地摘录，不花模型调用
    dshBin: dsh
    profile: headless       # v0.2.3 起会自动把宿主 GUI 的模型配置桥接进来
                            # （官方/中转线路通用，无需手动配置）
    timeoutMs: 180000
    businessContext: |-
      用户是一位正在创业的独立开发者……
```

## 毛选语料

- **33 篇，全部 `verified: true`**，覆盖第一至第五卷；
- 来源：中文马克思主义文库公开电子文本（https://www.marxists.org/chinese/maozedong/index.htm），仅作个人学习、研究之用；
- 重新抓取 / 扩充：`npm run corpus`；
- 版权与再分发限制见 [NOTICE](NOTICE) 和 [corpus/README.md](corpus/README.md)。

## 已知限制

- Web 宠物只支持 Web 界面（`dsh.client.platform: web`），终端 / TUI 里没有宠物；macOS 想让她离开界面，用上面的桌宠壳；
- 桌宠壳仅 macOS（系统 WebKit）；Windows / Linux 需要 Tauri 2 / Electron 起同款壳，`pet.html` 可直接复用；
- 定时器只在这个 `dsh web` 进程活着时走；进程停了不会补跑，重启后按 `nextRunAt` 决定是否补一次；
- headless 生成每次是独立会话（不复用上下文）：稳定，但「不记得昨天说过什么」——所以 prompt 里带最近 6 条督促来避免重复。

## License

- **代码**：MIT，见 [LICENSE](LICENSE)。
- **内置毛选语料**（`corpus/`）：**不是 MIT**。文本来自[中文马克思主义文库·毛泽东](https://www.marxists.org/chinese/maozedong/index.htm)，著作权归原作者与出版方，本项目仅作个人学习、研究之用的整理，不构成再出版或商业授权。详见 [NOTICE](NOTICE) 与 [corpus/README.md](corpus/README.md)。
- **立绘与图标**（`assets/`）：民间同人形象「鲸鱼娘·小毛」，与 DeepSeek 官方无关；素材记录见 [assets/PROVENANCE.md](assets/PROVENANCE.md)。
- 本项目与 DeepSeek、毛泽东著作出版方均无隶属关系；内容用于产品与创业方法论的阅读辅助，不作政治宣传。

---

包名 `dsh-plugin-maoxuan-pet` · [English](README.en.md) · 技术细节（架构、接口契约、内容规范、验证方式）见 [docs/](docs/)：[API-CONTRACT.md](docs/API-CONTRACT.md) · [CONTENT-FRAMEWORK.md](docs/CONTENT-FRAMEWORK.md) · [verify/README.md](verify/README.md)

[![verify](https://github.com/yuna78/dsh-maoxuan-pet/actions/workflows/verify.yml/badge.svg)](https://github.com/yuna78/dsh-maoxuan-pet/actions/workflows/verify.yml) [![npm](https://img.shields.io/npm/v/dsh-plugin-maoxuan-pet.svg)](https://www.npmjs.com/package/dsh-plugin-maoxuan-pet)
