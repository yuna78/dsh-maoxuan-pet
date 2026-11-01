# 安装 / 卸载 / 排错

两种装法，二选一：

- **从 npm 装**（普通用户走这条）：`dsh plugin --profile web add dsh-plugin-maoxuan-pet`
- **从源码装**（改代码时走这条）：把当前 profile 指向本目录，见下面的 `install.mjs`

两种方式装完都要**重启 `dsh web`**（Ctrl+C 后重新 `dsh web`），再刷新页面。

## A. 从 npm 安装

```bash
dsh plugin --profile web add dsh-plugin-maoxuan-pet
# 想固定版本：dsh-plugin-maoxuan-pet@0.2.1
dsh plugin --profile web list          # 确认出现在列表里
```

卸载：`dsh plugin --profile web remove dsh-plugin-maoxuan-pet`。

## B. 从源码安装（本目录）

```bash
cd /path/to/dsh-maoxuan-pet
node install.mjs --dry-run     # 先看清楚要改什么
node install.mjs               # 真正写入 profile 清单并让 dsh 执行 pnpm link
```

`install.mjs` 只做三件事：

1. 备份 `$DSH_HOME/profiles/<profile>/package.json` 为 `package.json.bak-maoxuan-<时间戳>`；
2. 在 `dependencies` 里加 `"dsh-plugin-maoxuan-pet": "link:<本目录绝对路径>"`；
3. 在 `dsh.profile.bundles` 里加 `dsh-plugin-maoxuan-pet`（紧跟 `dsh-plugin-token-burned` 之后，没有就追加）。

然后调用 `dsh plugin --profile web install` 让 DSH 自己跑 pnpm。**它不会重启正在运行的 dsh 进程。**

卸载：

```bash
node install.mjs --uninstall
```

## 必须重启才生效

插件（Host 行 + Client bundle + preset）是在 profile 启动时组装的，热更新只在 `dsh-hmr` 开着且 profile 打开 `patchReload: live` 时才覆盖配置行；**新增一个 bundle 的 Client 资源必须重启**。

当前 GUI 跑在 `dsh web` 进程里。重启方式：

1. 找到跑 `dsh web` 的那个终端（`lsof -nP -iTCP:3080 -sTCP:LISTEN` 能看到 pid），按 `Ctrl+C`；
2. 重新执行 `dsh web`；
3. 浏览器刷新 `http://127.0.0.1:3080`。

> 注意：如果你正通过这个 GUI 里的会话让 agent 去重启，它会把自身会话一起杀掉。请由人手动执行，或先确认会话已保存。

## 安装后自检

```bash
# 1) 组装后的 profile 里应有我们的行与 preset
dsh --profile web --dump-config | grep -n "maoxuan" | head

# 2) 页面右下角出现鲸鱼娘；气泡出现时能点「收起」「再督促我一次」

# 3) Host 路由活着（不需要密钥）
curl -s http://127.0.0.1:3080/api/dsh-maoxuan-pet.state | head -c 400

# 4) 立刻触发一次生成（会真的调用模型）
curl -s -X POST http://127.0.0.1:3080/api/dsh-maoxuan-pet.generate | head -c 600
```

## 每小时生成是怎么跑的

Host 半个插件在 `apply()` 里挂一个 `ctx.timeout` 定时器：

- 首次：进程启动后 `firstDelaySeconds`（默认 90s）；
- 之后：每次生成完再排 `everySeconds`（默认 3600s）；
- 静默时段 `quietHours` 内不生成，到窗口结束时补一次；
- 每天 `dailyLimit` 次上限，防止定时器失控烧钱；
- 每次生成 `spawn` 一个 `dsh --profile headless --json "<prompt>"` 子进程，prompt 里只放当篇的 `quote + summary + businessAngle`（控制 token），解析子进程 `final` 事件里的 JSON；
- 子进程失败 / 超时 / 输出不是 JSON → **降级为本地摘录**，气泡上明确标「离线摘录」，同时把真实错误写进 `state.lastError`，绝不冒充“模型生成”。

把 `headless` 换成 `false` 可以完全关掉模型调用，只用本地摘录（省钱、离线可用）：

```yaml
- id: dsh-maoxuan-pet
  config:
    headless: false
```

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 右下角没有鲸鱼娘 | 还没重启，或 bundle 没进 `dsh.profile.bundles` | 跑 `node install.mjs --dry-run` 看清单，重启 |
| 有宠物但没有气泡 | 还没生成过；或生成落在静默时段 | `POST /api/dsh-maoxuan-pet.generate` 手动触发 |
| 气泡一直显示「离线摘录」 | headless 子进程失败：没有 key、没有 `dsh` 命令、模型超时 | 看 `state.lastError`；确认 `~/.dsh/.env` 里有 `WOCHENG_API_KEY`，且 `dsh --version` 可执行 |
| preset 里没有「毛选创业参谋」 | bundle 未生效 | 重启后确认 `dsh --profile web --dump-config` 里出现 `preset-maoxuan-pet` |
| 毛选 skill 加载不到 | `corpus/index.json` 缺失或校验失败 | 跑 `npm run corpus`，看 `state.corpus.error` |
| 每小时太吵 / 太贵 | 默认间隔 1 小时 | 调 `everySeconds` / `quietHours` / `dailyLimit` |

## 回滚

```bash
cp "$HOME/.dsh/profiles/web/package.json.bak-maoxuan-<时间戳>" "$HOME/.dsh/profiles/web/package.json"
```

然后重启 `dsh web`。状态文件 `~/.dsh/storages/dsh-maoxuan-pet.json` 可以安全删除，插件会重建。
