# dsh-maoxuan-pet 内部契约（Host ↔ Client ↔ Corpus）

本文件是三个并行工作流（Host 逻辑 / Client UI / 毛选语料）之间唯一的接口约定。
改动契约必须同时更新本文件，并让 `verify/` 的契约测试通过。

## 1. 插件身份

| 项 | 值 |
|---|---|
| npm 包名 | `dsh-plugin-maoxuan-pet` |
| Cordis 行 id | `dsh-maoxuan-pet` |
| Client 模块 id | `dsh-plugin-maoxuan-pet`（必须与包名一致） |
| 配置目录名 | `dsh-maoxuan-pet`（位于 `$DSH_HOME/storages/`） |

## 2. Host 配置（`apply(ctx, config)`，全部可选）

```yaml
- id: dsh-maoxuan-pet
  name: dsh-plugin-maoxuan-pet
  config:
    enabled: true                # false 时不启动定时器（手动路由仍可用）
    everySeconds: 3600           # 生成间隔
    firstDelaySeconds: 90        # 进程启动后首次生成延迟
    quietHours: [1, 7]           # 本地时区静默时段 [起, 止)，跨零点用 [22, 7]
    maxBubbles: 40               # 历史气泡保留条数
    headless: true               # true=用 dsh headless 子进程生成；false=只用本地摘录模板
    dshBin: dsh                  # headless 可执行文件（PATH 或绝对路径）
    profile: headless            # 传给子进程的 --profile
    timeoutMs: 180000            # 子进程超时
    businessContext: 40 岁男性…  # 用户创业背景，注入 prompt，可留空
    modelHint: ''                # 可选，仅写入 prompt 的语言风格提示
```

## 3. HTTP 路由（Host 注册，同源，浏览器直接 fetch）

所有路由前缀 `/api/dsh-maoxuan-pet.`，`cache-control: no-store`。

### `GET /api/dsh-maoxuan-pet.state`

返回快照，Client 每 20s 轮询一次。**这是 Client 唯一的状态来源。**

```json
{
  "version": 1,
  "enabled": true,
  "running": false,
  "mode": "headless",
  "everySeconds": 3600,
  "now": "2026-11-01T03:30:00.000Z",
  "lastRunAt": "2026-11-01T03:00:12.000Z",
  "nextRunAt": "2026-11-01T04:00:00.000Z",
  "lastError": null,
  "unread": 1,
  "current": { "…Bubble…" },
  "bubbles": [ { "…Bubble…" } ],
  "corpus": { "count": 36, "lastTitle": "反对本本主义", "updatedAt": "2026-10-31T00:00:00.000Z" },
  "pet": {
    "name": "鲸鱼娘·小毛",
    "sprites": {
      "idle": "/api/dsh-maoxuan-pet.asset?name=idle",
      "talk": "/api/dsh-maoxuan-pet.asset?name=talk",
      "blink": "/api/dsh-maoxuan-pet.asset?name=blink"
    }
  }
}
```

- `current`：最新的**未读**气泡；没有未读时为 `null`（Client 只在 `current != null` 时展示气泡）。
- `bubbles`：按时间倒序，最多 `maxBubbles` 条，含已读。
- `lastError`：`null` 或 `{ "at": ISO, "message": string }`（截断到 300 字符）。

### Bubble 结构 v2（Host 生成，Client 只渲染）

**一条气泡 = 一次「取材方式 × 启示落点」组合，正文合计 ≤200 字。**
用户明确要求：不要长篇分析，要一句话原文 + 一句启示，站在宠物小毛的角度说。

```json
{
  "id": "b-20261101T034014-963f",
  "at": "2026-11-01T03:40:14.856Z",
  "read": false,
  "mode": "headless",
  "template": "quote",
  "articleId": "hu-nan-nong-min-yun-dong-kao-cha-bao-gao",
  "title": "湖南农民运动考察报告",
  "year": "1927年3月",
  "sourceUrl": "https://www.marxists.org/chinese/maozedong/…",
  "cite": { "kind": "quote", "label": "原文", "text": "革命不是请客吃饭，不是做文章，不是绘画绣花，不能那样雅致，那样从容不迫，文质彬彬，那样温良恭俭让。" },
  "axis": "项目",
  "pua": "别把立项做成表态。先拿原话回来。",
  "lesson": "立项前立一条硬规则：每个新需求先约五个真实客户，每人二十分钟，只记原话、不推销；找不到原话支撑的痛点就不立项。可验证：每条注明客户、日期、来源。",
  "chars": 168,
  "tone": "sharp"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `template` | `quote` \| `excerpt` \| `summary` | 本条用的模板：金句 / 文章节选 / 小毛概括 |
| `cite.kind` | 同上 | 与 `template` 一致，便于 Client 只读一个字段 |
| `cite.label` | `原文` \| `节选` \| `小毛概括` | 中文标签，Client 直接显示 |
| `cite.text` | ≤70 字（excerpt ≤90） | `quote`/`excerpt` **必须逐字来自语料文件**；`summary` 是概括，不得加引号 |
| `axis` | `客户` \| `项目` \| `组织` \| `现金流` \| `决策` \| `自律` | 启示落点；Client 用作 chip。旧名字 `人事` 在读取状态文件时迁移为 `组织`（`LEGACY_AXES`） |
| `pua` | ≤40 字，**可为空字符串** | 小毛对用户说的一句话，第一人称，直接、不羞辱、不编造事实。**模型若复述原文（与 `cite.text` 有 ≥8 字公共串）则整条丢弃**，气泡只显示引文与启示；空串时 Client 不渲染这一行 |
| `lesson` | ≤100 字（超预算时会被截到 `200 - cite.text - pua` 以内） | 启示：一条能落地的规则 + 怎么验证；围绕 `axis` |
| `chars` | 数字 | `cite.text + pua + lesson` 的字数（用于校验 ≤200） |
| `mode` | `headless` \| `offline` | `offline` 必须由 UI 标注「离线摘录」 |
| `tone` | `sharp` \| `calm` \| `urgent` | 只影响配色，不影响内容 |

约束：

- **200 字硬上限**：`fitLesson(cite.text, pua, lesson)` 只动 `lesson`——先按句读截到 `200 - cite - pua` 以内，句读窗口太窄时硬截并补 `…`；剩余额度为 0 时 `lesson` 为空串、`chars` 恰好 200。`cite.text`（≤70/90）与 `pua`（≤40）各自先被限长，所以三段之和恒 ≤200，该不变量由 `verify/contract.mjs` 的 `fitLesson` 用例锁定。
- **引用必须可核**：`quote`/`excerpt` 的文本必须在对应 `corpus/articles/<id>.md` 里 `includes()` 命中，否则该条降级为 `summary`。
- **节选**从文章正文里整段/整句取，不在句子中间切；`summary` 由模型概括（≤70 字）或退化为语料 `summary` 的首句。
- 模板轮转：`quote → excerpt → summary` 循环，游标持久化在状态的 `templateCursor` 里（**不能用 `bubbles.length`**：`maxBubbles` 截断后长度不再变化，轮转会被钉死）。`axis` 尽量与上一条不同（prompt 里会提示）。
- `cite.text` 永不回退成篇名：`summary` 模式取语料 `summary` 首句；离线路径由 `offlineBubble` 直接给出已核对的 `cite`，`runOnce` 优先采用它。

| 兼容 | 旧字段（`thought` / `insight` / `nag` / `action`）在 Host 读取旧状态文件时会被迁移成 v2 结构，Client 也保留旧字段的兜底渲染。


### `POST /api/dsh-maoxuan-pet.generate`

立即生成一条。请求体可省略（`{}`）。响应：

```json
{ "ok": true, "running": false, "bubble": { "…Bubble…" } }
```

已在生成中：`{ "ok": true, "running": true, "bubble": null }`（HTTP 202，不排队重复生成）。
生成失败且离线模板也不可用：`{ "ok": false, "running": false, "bubble": null, "error": "…" }`（HTTP 500）。

### `POST /api/dsh-maoxuan-pet.dismiss`

请求体 `{ "id": "b-…" }`，把该气泡标记为已读；`id` 缺失时把 `current` 标记为已读。
响应 `{ "ok": true, "unread": 0 }`。

### `GET /api/dsh-maoxuan-pet.asset?name=idle|talk|blink|read`

返回 `assets/` 下的 PNG，`content-type: image/png`，`cache-control: public, max-age=3600`。
找不到资源时 404 纯文本，**不要**返回 500 或占位图以外的伪造内容。

### `GET /api/dsh-maoxuan-pet.corpus`

`{ "articles": [ { "id", "title", "year", "tags", "quote", "summary" } ] }`（不含全文，供 Client 展示“这小时读了哪篇”）。

## 4. 语料契约（`corpus/`）

`corpus/index.json`：

```json
{
  "version": 1,
  "generatedAt": "2026-10-31T00:00:00.000Z",
  "edition": "据中文马克思主义文库公开电子文本整理",
  "sources": [
    { "name": "中文马克思主义文库 · 毛泽东", "url": "https://www.marxists.org/chinese/maozedong/index.htm" }
  ],
  "articles": [
    {
      "id": "fan-dui-ben-ben-zhu-yi",
      "title": "反对本本主义",
      "year": "1930年5月",
      "date": "1930-05",
      "volume": "第一卷",
      "tags": ["调查研究", "实践"],
      "file": "articles/fan-dui-ben-ben-zhu-yi.md",
      "sourceUrl": "https://www.marxists.org/chinese/maozedong/marxist.org-chinese-mao-193005.htm",
      "quote": "没有调查，没有发言权。",
      "summary": "150–250 字主旨：先交代当时面对的问题，再概括论证。",
      "businessAngle": "一条可观察的创业应用角度。",
      "verified": true
    }
  ]
}
```

- `id`：kebab-case，唯一，与文件名一致。
- `quote`：**逐字核对**过的一句原文，不得拼接不同段落；`verified: false` 的条目不进入生成 prompt。
- 全文放在 `corpus/articles/<id>.md`，首行 `# 篇名`，其后为公开电子文本，末尾附来源段。
- 生成 prompt 只使用 `quote` + `summary` + `businessAngle`（控制 token），全文留给 preset 会话里的 agent 用 `read` 工具读取。

## 5. 目录归属（并行写入边界）

| 路径 | 负责人 | 说明 |
|---|---|---|
| `package.json`、`cordis.patch.yml`、`index.js`、`docs/` | Lead | Host 逻辑与安装 |
| `client.js` | client-ui | 只写这一个文件 |
| `assets/**` | pet-artist | 立绘、图标、PROVENANCE.md |
| `corpus/**`、`scripts/**`、`skill/**` | corpus-scholar | 语料、抓取脚本、preset skill |
| `verify/**` | verifier | 单测与端到端脚本 |

## 6. 实现注意事项（踩过的坑，改动前务必先读）

1. **路由必须显式声明 `requestBody: 'buffered'`。**
   `ctx.connection.fetch.register({ path, methods, fetch })` 不校验这个方法。缺省时 bridge 会按“流式”构造请求，
   对 GET 会 `new Request(url, { method:'GET', body: ReadableStream })` 抛错，Host 最终返回 **400 且 handler 根本不被调用**。
   本项目 5 条路由全部显式写了 `requestBody: 'buffered'`（POST 也写，统一行为）。
   复现方式：去掉任一 `requestBody` 后真实 `dsh web` 里 `curl` 该路由 → 400。

2. **`ctx.timeout()` 需要 `inject` 里包含 `'timer'`。**
   只写 `inject: ['connection']` 时，真实 profile 启动会直接 fatal：
   `cannot get property "timer" without inject`。本项目用 `inject = ['connection', 'timer']`；
   `skills` 用 `ctx.inject(['skills'], …)` 可选注入，缺注册表时宠物照常工作、只是没有毛选 skill。

3. **`bubble.id` 形态固定为 `b-YYYYMMDDTHHMMSS-xxxx`**（例 `b-20261101T034014-963f`），
   Client 只回传、不解析；`verify/host.test.mjs` 有对应正则断言。

4. **状态文件是唯一真相**：`$DSH_HOME/storages/dsh-maoxuan-pet.json`（测试可用 `DSH_MAOXUAN_PET_STATE` 覆盖），
   写入走 `.tmp` + `rename`；宿主重启后从该文件恢复 `cursor / bubbles / nextRunAt`。

5. **真实启动验证不等于单测**：本项目是在一个隔离的 `DSH_HOME` 里跑真实 `dsh web` 才发现上面第 1、2 条问题的，
   改了路由注册或 inject 之后，必须再做一次隔离启动 + curl 的验证，单测覆盖不到这两类失败。
