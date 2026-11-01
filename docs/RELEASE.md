# 发布 runbook（npm → 市场收录 → 本地索引）

目标：代码开源 + 发到 npm + 被 <https://awesome-dsh-plugin.com> 收录（DSH 插件库）。
**发布动作不可逆**（npm 版本号一旦上线不能复用），所以下面每一步都先核对再执行。

## 0. 现状与前置条件

| 项 | 现状（2026-11-01 核对） |
|---|---|
| 包名 | `dsh-plugin-maoxuan-pet`（unscoped，npm 上未占用） |
| 版本 | `0.3.0` |
| 代码许可 | MIT（`LICENSE`）；语料与立绘的非 MIT 声明见 `NOTICE` |
| 打包清单 | `npm pack --dry-run` → 64 files / 1.3 MB（含 33 篇语料 + desktop/ 5 个壳源码文件；`desktop/build/` 产物靠 files 逐文件点名排除，勿改回整目录收录） |
| GitHub 账号 | `gh auth status` → `yuna78`（scopes 含 `repo`） |
| npm 凭据 | `npm whoami` → `yuna78`（2026-11-01 复核有效）；发布需 2FA 一次性验证码，`npm publish --otp=<6位码>` |
| 市场收录机制 | awesome-dsh-plugin 索引 **npm 包**（`versions[].source.type = npm`），并用 `package.json` 的 `repository.url` 关联 GitHub 仓；**没有投稿表单**，发布后由爬虫收录 |

## 1. 发布前自检（每次都跑）

```bash
node verify/smoke.mjs && node verify/contract.mjs && node verify/host.test.mjs
node tools/audit-corpus-coverage.mjs          # 金句逐字命中 33/33 才算健康
npm pack --dry-run | tail -20                   # 确认没有 .dsh-dev/、assets/raw/、verify/
grep -rInE "sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}" --include="*.js" --include="*.json" . | grep -v node_modules
grep -rIn "/Users/" --include="*.md" --include="*.js" . | grep -v node_modules   # 不应出现本机绝对路径
```

## 2. 发 npm

```bash
npm login                      # 必须：当前 token 已失效（401）
npm whoami                     # 期望输出 yuna78
npm publish --access public    # 包名未占用，走 unscoped
npm view dsh-plugin-maoxuan-pet version dist-tags
```

发布后核对 `repository` / `homepage` 是否正确（市场页靠它关联仓库）：

```bash
curl -s https://registry.npmjs.org/dsh-plugin-maoxuan-pet | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.repository, j.homepage, j['dist-tags']);});"
```

## 3. 开源仓

这个包当前是 `dsh-plugin/` 总仓里的一个未跟踪目录。两种做法：

```bash
# 方案 A（推荐，和 dsh-agent-tree / dsh-deck-studio 一致）：独立公开仓
gh repo create yuna78/dsh-maoxuan-pet --public --source=. --remote=origin --push

# 方案 B：留在总仓
# 让 registry.extra.json 的 publicRepo 指向 https://github.com/yuna78/dsh-plugin
```

`package.json` 里的 `repository` / `homepage` / `bugs` 目前按**方案 A** 写成 `yuna78/dsh-maoxuan-pet`；
若选方案 B，先改这三个字段再 publish（npm 版本号不能复用，顺序不能反）。

## 3.5 发布后体检（一条命令）

```bash
node scripts/post-publish-check.mjs            # 只报告：npm latest / repository / 市场收录
node scripts/post-publish-check.mjs --strict   # 门禁：版本不符或市场未收录则 exit 1
```

注意两个真实踩过的坑：

1. **占位版本**：首次发布前若先推了一个 `0.0.0-stage` 之类的 stub 占名，`latest` 会指向它。发完正式版后建议：
   ```bash
   npm deprecate dsh-plugin-maoxuan-pet@0.0.0-stage "占位版本，请使用 0.2.0"
   ```
2. **2FA**：账号开了 2FA 时 `npm publish` 会报 `EOTP`，需要 `--otp=<6 位动态码>`，动态码 30 秒过期——要么你在终端交互式输入，要么拿到码后立刻发。

## 4. 等市场收录 + 在本地索引里核对

```bash
# 收录后应能查到（爬虫有延迟，通常几分钟到一天）
curl -s https://awesome-dsh-plugin.com/index.json | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
const hit=(j.plugins||[]).filter(p=>p.name==='dsh-plugin-maoxuan-pet');
console.log(hit.length ? JSON.stringify(hit[0],null,2).slice(0,600) : '尚未收录');});"
```

本地索引（`../registry.json`，由 `../build-registry.mjs` 生成）会自动识别 npm 版本与公开仓；
若 `repository` 与市场条目对不上，在 `../registry.extra.json` 的 `publicRepo` 里手工补映射：

```json
{ "publicRepo": { "dsh-plugin-maoxuan-pet": "https://github.com/yuna78/dsh-maoxuan-pet" } }
```

```bash
cd .. && node build-registry.mjs --write    # 重算 registry.json / README 表格
node -e "const r=require('./registry.json');console.log(r.plugins.find(p=>p.name==='dsh-plugin-maoxuan-pet'))"
```

期望字段：`openSource: true`、`npm: "0.2.3"`、`market: { title: "yuna78/dsh-maoxuan-pet", version: "0.2.3" }`。

## 5. 版本号规则

- 修 bug / 文案：`npm version patch`
- 新模板、新落点、新 UI 能力：`npm version minor`
- 破坏 Bubble 契约或配置文件格式：`npm version major`（同时更新 `docs/API-CONTRACT.md` 的版本说明）
- 打 tag 前先跑第 1 步的自检；tag 名 `v<version>`，与 `package.json` 一致。

## 6. 回滚

- npm：`npm unpublish dsh-plugin-maoxuan-pet@<version>`（72 小时内可用，之后只能 deprecate）
- 推荐：`npm deprecate dsh-plugin-maoxuan-pet@<version> "…原因…"` 并立刻发新版
- 本地插件：`node install.mjs --rollback`（见 `docs/INSTALL.md`）
