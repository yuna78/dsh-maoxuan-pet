# verify/ — dsh-plugin-maoxuan-pet 验证套件

三条命令，只用 Node 内置模块（`node:test` / `node:assert` / `node:fs` / `node:path` / `node:os`）：

```bash
node verify/smoke.mjs        # 静态与结构检查，退出码 0/1
node verify/contract.mjs     # 纯函数契约单测（node:test）
node verify/host.test.mjs    # 假 ctx 端到端（不启动 DSH）
# 或一次跑完：
node verify/smoke.mjs && node verify/contract.mjs && node verify/host.test.mjs
```

环境要求：Node ≥ 20（用到 `node:test`、全局 `fetch`/`Request`/`Response`、`fs/promises.realpath`）。
不需要 `npm install`，不联网，不启动 `dsh` 子进程，不产生任何模型调用。

## 每条命令做什么

### `verify/smoke.mjs` — 静态与结构

| 检查 | 依据 |
|---|---|
| `package.json` 可解析；`name`/`type: module`/`main` | 契约 §1 |
| `exports.*`、`dsh.bundle.patch`、`dsh.client` 指向真实存在的文件 | 可安装性 |
| `cordis.patch.yml` 含 `id: dsh-maoxuan-pet`（Host 行）与 `id: preset-maoxuan-pet`（preset 行），且 preset 的 `plugins` 是非空数组 | 契约 §1 + 简易 YAML 文本断言（不引入依赖） |
| `node --check index.js`（`client.js` 存在时同样检查） | 语法 |
| `client.js` 含 v2 气泡 class：`mp-cite` / `mp-pua` / `mp-lesson` / `mp-close`（只查结构名，不写死样式） | 契约 §3 Bubble v2 + 用户反馈 |
| `docs/API-CONTRACT.md` 中声明的 5 条 `/api/dsh-maoxuan-pet.*` 路由都能在 `index.js` 里找到，且 `index.js` 导出的 `ROUTES` 集合与文档完全一致 | 契约 §3 |
| `corpus/index.json` **结构**：可解析、`version: 1`、唯一 `id`、`verified: true` 必须有 `quote`（Host 的 `validateCorpus()` 同款硬约束，违反会让整份语料在运行时被丢弃） | 契约 §4 |
| `corpus/index.json` **完整度**：`summary` 长度、`sourceUrl`、`file` 是否存在 → 只报 `WARN`，不判失败（语料内容由 corpus 工作流负责，写入过程中必然是半成品） | 契约 §4 |
| `SKILL.md` frontmatter 与长度；`assets/pet-idle|talk|blink.png` | 契约 §4 |

**WARN 语义**：语料 `summary` 长度、`sourceUrl`、`file` 缺失属于 corpus 工作流的内容质量项，先打印 `WARN` 并计数，不阻塞 Host 侧验证；等语料定稿后再看这份清单即可。结构性错误（唯一 id、`verified` 无 `quote`、版本、JSON 损坏）仍是硬失败。

**SKIP 语义**：`client.js`、`assets/icon.svg`、`corpus/index.json`、`skill/maoxuan-vademecum/SKILL.md`、立绘 PNG 属于并行工作流的产物。文件不存在时该行报 `SKIP`、不判失败（便于在并行开发中先跑通 Host 侧）；**一旦文件出现，同样的断言就变成硬失败**。Host 自有文件（`index.js`、`package.json`、`cordis.patch.yml`、`docs/`）缺失或损坏永远是失败。

### `verify/contract.mjs` — 契约单测

直接 `import { ... } from '../index.js'`，只用纯函数，不落盘、不联网。覆盖：

- `normaliseConfig`：契约 §2 默认值、越界钳制、非法输入回落、`quietHours` 容错；
- `resolveDshHome` / `resolveStatePath`：`$DSH_HOME/storages/dsh-maoxuan-pet.json` 与 `DSH_MAOXUAN_PET_STATE` 覆盖优先级（契约 §1）；
- `isQuietAt` / `quietEnd`：`[2,8)` 左闭右开、跨零点 `[22,7)`、`start === end` 表示“永不静默”；
- `startOfLocalDay`、`stripFrontmatter`；
- `extractJson`：纯 JSON、` ```json ` 围栏、前后废话、拼接/残缺 JSON；
- `pickArticle`：跳过 `verified: false` / 无 `quote`、轮转、`recentIds` 排除、耗尽兜底；
- `validateCorpus`：合法零错误、重复 id、`verified` 无 `quote`、版本/结构错误；
- **v2 气泡**（契约 §3）：
  - `TEMPLATES` / `TEMPLATE_LABEL` / `AXES` / `MAX_BUBBLE_CHARS` / `LIMITS` 常量与契约逐字一致；
  - `isVerbatim`：命中、改写不命中、空白折叠、空串；
  - `clipAtBoundary`：优先句号、退逗号、不超上限原样返回、窗口内无句读返回 `null`、切点太靠前返回 `null`；
  - `extractExcerpt`：整句窗口、≤ 上限、逐字命中正文、不同种子换段、太短/只有来源段返回 `null`；
  - `pickTemplate`：`quote → excerpt → summary` 轮转与负数/NaN 兜底；`deriveAxis`：tags → 落点、未知回落 `决策`；
  - `normaliseGenerated`：缺 `lesson` → `null`、非法 `axis`/`tone` 回落、`pua`/`lesson`/`gist` 截断；`pua` 为**可选**（契约 §3 已明确：模型复述原文时整条丢弃，空串 Client 不渲染）；
  - `fitLesson`：`cite + pua + lesson ≤ 200`、按句读截 `lesson`、`chars` 等于三段长度和；
  - `migrateBubble`：v1 `thought/insight/nag/action` → v2 `cite/template/axis/pua/lesson`，幂等，无 `quote` 时退 `summary`；
  - `longestSharedRun`：复述原文检测（`runOnce` 用 ≥8 丢弃回声 pua）；
  - `offlineBubble`：新签名 `(article, body, template, now)`，三种模板的 `cite.kind/label/text` 正确、`quote`/`excerpt` 逐字可核、`summary` 取语料 summary 首句而非篇名；
  - `buildPrompt`：要求 `pua/lesson/axis`（summary 模式要 `gist`、excerpt 模式带节选原文）、写明 200 字硬上限、不再要 v1 字段、`axis` 影响落点提示；
- `ROUTES`：与契约 §3 的五条路由逐字一致。

时间相关断言都构造**本地时间**（`new Date(y, m-1, d, h)`）且避开夏令时切换日，因此在任意时区都能跑。

### `verify/host.test.mjs` — 假 ctx 端到端

用假 Cordis ctx 直接调用 `apply(ctx, config)`，不启动 DSH：

```js
{ logger, effect(fn), inject(deps, cb), timeout(fn, ms), connection: { fetch: { register(route) } } }
```

`inject()` 立即用 `{ connection, skills, effect }` 回调，`timeout()` 只记录不触发（测试里没有任何真实等待），`effect()` 立即调用回调并保存 disposer。

**夹具为什么复制 `index.js`**：`apply()` 按 `import.meta.url` 定位 `assets/`、`corpus/`、`skill/`（这是安装后找到自带资源的正确做法）。要让这些路径指向临时目录而不改仓库文件，只能在临时目录里放一份**逐字节相同**的 `index.js` 并从那里 `import()`；测试在导入前会断言复制出的 `index.js` 与仓库文件逐字节一致，所以跑的还是真实 Host 代码。

夹具内容（全部位于 `fs.mkdtemp(os.tmpdir()/maoxuan-pet-verify-)`）：

- `corpus/index.json`：2 条 `verified: true` 的契约形状文章（反对本本主义 / 实践论）；
- `corpus/articles/<id>.md`：两篇最小“全文”，段落 ≥40 字且**真的包含**各自的 `quote`（`quote`/`excerpt` 逐字校验的夹具基础）；
- `assets/pet-idle.png`：1×1 PNG 字节；
- `DSH_MAOXUAN_PET_STATE=<tmp>/state/pet.json`：状态文件指向临时目录。

断言的 Host 行为：

1. `apply()` 返回 `snapshot`/`runOnce`/`config`；
2. 注册 5 条路由，`path` 与 `methods` 符合契约，且每条都带 `requestBody: 'buffered'`（契约 §6.1，缺了真实 `dsh web` 会回 400）；
3. `state` 路由：`version/enabled/running/mode/now/lastRunAt/nextRunAt/lastError/unread/current/bubbles/corpus/pet.sprites` 齐全，`cache-control: no-store`；
4. `generate`（`headless: false`）：HTTP 200，`bubble.mode === 'offline'`，v2 字段齐全——`id/at/read/mode/template/articleId/title/year/sourceUrl/cite{kind,label,text}/axis/pua/lesson/chars/tone`；`cite.kind === template`、`cite.label` 与 `TEMPLATE_LABEL` 一致、`chars === cite.text.length + pua.length + lesson.length` 且 `≤ 200`、`quote/excerpt` 的 `cite.text` 必须 `isVerbatim` 命中夹具全文、v1 字段（`thought/insight/nag/action/quote`）必须已消失；
5. 再次 `generate`：轮转到下一篇（排除最近用过的篇目）、**模板轮转 `quote → excerpt`**（第 2 条必须是 `excerpt` 且逐字命中全文）、`bubbles` 倒序、`current` 指向最新未读；
6. `maxBubbles` 截断生效；
7. `dismiss`：按 `id` 标已读 → `unread` 递减；省略/非法 body → 标记 `current`，不 500；无未读时 `current === null`；
8. **并发 `generate`**：`Promise.all` 两次 POST → 一次 200（带 bubble）+ 一次 202（`running: true`、`bubble: null`），只多 1 条未读、`running` 复位；
9. `asset`：`image/png` + `public, max-age=3600`，字节等于夹具 PNG；未知 `name` 与无 `name` 回落到 `idle`；**删除图片后返回 404 纯文本，绝不 500、不返回伪造内容**；
10. `corpus` 路由：只返回 `id/title/year/tags/quote/summary`，不泄漏 `file`/全文；
11. 状态文件被原子写入（`writeFile .tmp` → `rename`）：JSON 可解析、目录里没有残留 `.tmp`；
12. `skill` 注册：`maoxuan-vademecum` / `source: bundled` / `resourceBase` 指向临时 `corpus/`、内容含篇目索引与运行时路径；
13. `dispose()` 可重复调用不抛错；`enabled: false` 时零定时器；`enabled: true` 时 `arm()` 设置未来 `nextRunAt` 且只注册一个假定时器；
14. 结束前断言临时目录确实被删除。

另有独立用例 `host E2E：语料为空时 generate 稳定返回 500，且 running 不会卡死（回归）`：空 `corpus/articles` 夹具下 `generate` 返回 500 `{ok:false, running:false}` 且写 `lastError`，连调两次仍是 500（若 `running` 卡死会变成 202），`state.running === false`、无气泡残留。

轮询上限 2s（`waitFor`，10ms 间隔）：`state`/`corpus` 路由内部已 `await ready`，正常情况无需等待。

## 哪些是“真实外部调用”，默认不跑

- **headless 生成（`dsh --profile headless …`）**：会起子进程、联网、消耗模型调用。本套件固定 `headless: false`，`runHeadless()` 不可达，只验证降级路径（`mode: 'offline'`）。手工验证时用真实 profile 打开 `headless: true` 并调用 `POST /api/dsh-maoxuan-pet.generate`，不在自动化里跑。
- **语料抓取（`scripts/fetch-corpus.mjs`）**：需要网络，由 corpus 工作流自己验证，不在 `verify/` 里跑。
- 本套件自身只读写临时目录，**不会**写入 `assets/`、`corpus/`、`state` 或任何仓库文件。

## 回归断言（针对已修复的 Host 缺陷）

发现 → 报 lead → Host 修复 → 在这里补一条会变红的回归，避免同一问题复活：

| 原问题 | 修复 | 回归断言 |
|---|---|---|
| YAML 里 `maxBubbles:` 空值（`null`）被 `Number(null) === 0` 钳到最小值，历史气泡只剩 1 条 | `int()` 把 `null` / `undefined` / `''` 视为“未配置”并回落 fallback | `contract.mjs`：`normaliseConfig({ maxBubbles: null }).maxBubbles === 40`、`everySeconds: null → 3600`、`timeoutMs: null → 180000`、`quietHours: [null, null] → [2, 8]`；同时断言数字 `0` 仍钳到最小值 |
| `stripFrontmatter()` 在 frontmatter 后留下前导换行，注册的 skill 正文首行为空 | 整段前导空行被剥离 | `contract.mjs`：`stripFrontmatter('---\nname: x\n---\n\n# T\n') === '# T\n'`、连续空行与 CRLF 变体 |
| `bubble.id` 实测 `b-<15 位数字>-<4 hex>`，与契约 `b-YYYYMMDDTHHMMSS-xxxx` 不一致 | `makeBubbleId()` 改为契约格式 | `host.test.mjs`：`/^b-\d{8}T\d{6}-[0-9a-f]{4}$/`（单条与并发两处） |
| 并发两个 `POST /generate` 各生成一条气泡 | `runOnce()` 同步抢占 in-flight 位 + `try/catch/finally` | `host.test.mjs`：`Promise.all` 两次 generate → 状态码 `[200, 202]`、只多 1 条未读、`running` 复位；空语料场景连调两次仍是 500（不是 202），证明 `running` 不会卡死 |

## v2 契约漂移（已逐条裁决并落地，保留现场供复核）

verifier 在 v2 重写后报了 6 条漂移，lead 已全部裁决：5 条改代码、1 条改契约。下面每条都附可复现命令，方便下一个人不信任任何结论、自己重跑一遍。

| # | 原现象 | 裁决与修复 | 复核命令（真实输出） |
|---|---|---|---|
| 1 | 模板轮转在 `maxBubbles` 封顶后停滞（用 `bubbles.length` 做种子） | **改代码**：持久化 `templateCursor`，迁移旧状态文件时按已有条数播种 | `node -e "import('./index.js').then(m=>console.log([0,1,2,3].map(m.pickTemplate).join(',')))"` → `quote,excerpt,summary,quote`；`host.test.mjs` 断言连续两次 generate 的 template 不同 |
| 2 | `summary` 模板的 `cite.text` 退化成篇名 | **改代码**：取语料 `summary` 首句（`clipAtBoundary`），离线路径优先采用 `offlineBubble` 已核对的 `cite`，注释写明「永不回退成篇名」 | 真实 headless 气泡：`template=summary`、`cite.text` 是概括句而非标题（见 `docs/CONTENT-FRAMEWORK.md` §6 样例） |
| 3 | `pua` 从「必填」变成「可选」，契约没写 | **改契约**：`API-CONTRACT.md` §3 明确「`pua` ≤40 字，**可为空字符串**」，并写明回声规则（与 `cite.text` 有 ≥8 字公共串则整条丢弃） | `node -e "import('./index.js').then(m=>console.log(JSON.stringify(m.normaliseGenerated({lesson:'有启示'}))))"` → `pua:""` 而 `lesson` 保留 |
| 4 | `isVerbatim` 只折叠连续空白，正文硬换行时会误判不命中 | **改代码**：`raw.includes` → 折叠空白 → **去掉全部空白** 三级比较 | `node -e "import('./index.js').then(m=>console.log(m.isVerbatim('没有调查，没有\\n发言权。','没有调查，没有发言权。')))"` → `true` |
| 5 | `fitLesson` 的 `room` 有 24 字下限，极端组合可超 200 | **改代码**：去掉下限，`room = max(0, 200 - cite - pua)`；额度为 0 时 `lesson` 为空串、`chars` 恰好 200 | `node -e "import('./index.js').then(m=>console.log(JSON.stringify(m.fitLesson('引'.repeat(190),'说'.repeat(10),'长'.repeat(100)))))"` → `{"lesson":"","chars":200}` |
| 6 | `extractExcerpt` 不剥 Markdown 列表符，节选可能以 `* ` 开头 | **改代码**：段首 `replace(/^(?:[*\-•]|\d+[.、])\s+/,'')`，剥完再判定长度 | 33 篇真实语料扫描：节选非空 32/33、长度 40–90 字、以列表符开头的 0 条（唯一落空的是《关于领导方法的若干问题》，该篇正文以短标题段为主，已按设计降级为金句） |


## 已知局限（当前仍存在，均不影响契约）

- `headless: true` 的真实模型生成（会起子进程、联网、花模型调用）永远不在本套件里跑，只验证 `mode: 'offline'` 降级路径。
- `corpus/index.json` 与 `articles/*.md` 由 corpus 工作流持续更新；`summary` 长度、`sourceUrl`、`file` 存在性等**内容完整度**问题只报 `WARN`，结构项（`version`、唯一 `id`、`verified → quote`）仍是硬失败。当前 33 篇全文已落地，WARN/SKIP 均为 0。
- 立绘 PNG、`assets/icon.svg`、`skill/maoxuan-vademecum/SKILL.md` 未落盘时对应检查为 `SKIP`，文件出现即自动转硬检查（现已全部落盘）。

## 只写 `verify/`

按任务分工（契约 §5），`verify/**` 归 verifier。若发现 Host 缺陷，**不在**这里改 `index.js`，而是带复现命令报给 lead：

```bash
node verify/contract.mjs   # 单测层面
node verify/host.test.mjs  # 路由/状态层面
```

## 维护约定

- 新增 Host 纯函数 → 在 `contract.mjs` 补一组 `test()`，覆盖合法路径与降级路径。
- 新增路由或字段 → 先更新 `docs/API-CONTRACT.md`，`smoke.mjs` 的路由集合断言与 `host.test.mjs` 会同时要求实现跟上。
- 夹具一律在 `mkdtemp` 里造、`finally` 里删；不要在仓库里留测试状态文件。
- 用 `ctx.timeout()` 就必须在 `export const inject` 里声明 `'timer'`（Cordis 未注入时取属性会直接报错，真实 `dsh web` 启动会失败）；`smoke.mjs` 会检查这条不变式。
- `inject` 断言只锁定**实际依赖**（`connection`，以及代码用到 `ctx.timeout()` 时的 `timer`），不锁死服务列表顺序，便于后续增删可选服务。
