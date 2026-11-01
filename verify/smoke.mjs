#!/usr/bin/env node
/**
 * Structural smoke test for `dsh-plugin-maoxuan-pet`.
 *
 * `node verify/smoke.mjs` -> exit 0 on success, 1 on the first broken invariant.
 *
 * Deliberately dependency-free: only node builtins, no network, no `dsh`
 * subprocess, no model calls. Everything here is either a file read, a
 * `node --check` syntax pass, or a text assertion on the bundle patch.
 *
 * Artifacts owned by the parallel workstreams (client.js, assets/icon.svg,
 * corpus/index.json, skill SKILL.md) are still *checked when present*, but a
 * missing one is reported as SKIP instead of a failure so this suite can be
 * used while those files are being written. Everything the Host owns
 * (index.js, package.json, cordis.patch.yml, docs/) is a hard failure.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => join(root, ...p);
const rel = (p) => p.replace(`${root}/`, '');

let checks = 0;
let skips = 0;
const problems = [];
const warnings = [];

/**
 * Soft finding: 属于并行工作流（语料/素材）的内容质量问题，先记录并
 * 在末尾以 WARN 打印，不阻塞 Host 侧验证。结构性问题仍用 assert 硬失败。
 */
function warn(title) {
  warnings.push(title);
}

/** Run one check; `optional` means "absent is a SKIP, present must be valid". */
function check(title, fn, { optional = false } = {}) {
  try {
    const result = fn();
    checks += 1;
    if (result === SKIP) {
      skips += 1;
      console.log(`SKIP ${title}`);
    } else {
      console.log(`PASS ${title}`);
    }
  } catch (error) {
    checks += 1;
    problems.push(`${title}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
    console.log(`FAIL ${title}`);
    if (optional) throw error;
  }
}
const SKIP = Symbol('skip');

/** Assert a path referenced by package.json exists and is a regular file. */
function assertFile(relativePath, label, { optional = false } = {}) {
  const target = at(relativePath);
  if (!existsSync(target)) {
    if (optional) return SKIP;
    assert.fail(`${label} 指向的文件不存在：${relativePath}`);
  }
  assert.ok(statSync(target).isFile(), `${label} 指向的不是普通文件：${relativePath}`);
  return true;
}

// --- 1. package.json --------------------------------------------------------
const pkgText = readFileSync(at('package.json'), 'utf8');
let pkg;
check('package.json 可解析为 JSON 对象', () => {
  pkg = JSON.parse(pkgText);
  assert.equal(typeof pkg, 'object');
  assert.ok(pkg && !Array.isArray(pkg));
  return true;
});

check('package.json 名称与 cordis 行 id 一致（契约 §1）', () => {
  assert.equal(pkg.name, 'dsh-plugin-maoxuan-pet');
  assert.equal(pkg.type, 'module', 'type 必须是 module（index.js 使用 ESM）');
  return true;
});

check('package.json main 存在', () => assertFile('index.js', 'main'));

check('package.json exports. 指向真实文件', () => {
  assert.equal(pkg.exports?.['.'], './index.js');
  return assertFile('index.js', 'exports["."]');
});

check('package.json exports["./package.json"] 指向真实文件', () => {
  assert.equal(pkg.exports?.['./package.json'], './package.json');
  return assertFile('package.json', 'exports["./package.json"]');
});

check('package.json dsh.bundle.patch 指向 cordis.patch.yml', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  return assertFile('cordis.patch.yml', 'dsh.bundle.patch');
});

check('package.json dsh.client 声明 web 平台并依赖布局插件', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject 应为数组');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'));
  assert.equal(pkg.dsh?.client?.immediately, true, 'web client 应 immediately:true 才会随面板加载');
  return true;
});

// client.js / icon.svg 属于并行工作流的产物：缺失时 SKIP，存在时必须合法。
check('package.json exports["./client"]（存在则校验）', () => {
  assert.equal(pkg.exports?.['./client'], './client.js');
  return assertFile('client.js', 'exports["./client"]', { optional: true });
});

check('package.json exports["./icon"]（存在则校验）', () => {
  assert.equal(pkg.exports?.['./icon'], './assets/icon.svg');
  return assertFile('assets/icon.svg', 'exports["./icon"]', { optional: true });
});

check('package.json files 覆盖运行时必需文件', () => {
  const files = pkg.files ?? [];
  for (const needed of ['index.js', 'client.js', 'cordis.patch.yml', 'assets/', 'corpus/', 'skill/']) {
    assert.ok(files.includes(needed), `files 缺少 ${needed}（npm 发布会漏掉运行时资源）`);
  }
  return true;
});

// --- 2. cordis.patch.yml ---------------------------------------------------
const patch = readFileSync(at('cordis.patch.yml'), 'utf8');
const patchLines = patch.split(/\r?\n/);

/** Collect the indented body of `- id: <id>` rows in the patch file. */
function patchRowBodies(textLines, id) {
  const bodies = [];
  for (let i = 0; i < textLines.length; i += 1) {
    const line = textLines[i];
    const m = line.match(/^(\s*)-\s+id:\s*['"]?([^'"#\s]+)['"]?\s*$/);
    if (!m || m[2] !== id) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < textLines.length; j += 1) {
      const next = textLines[j];
      if (!next.trim() || next.trim().startsWith('#')) { body.push(next); continue; }
      const nextIndent = next.match(/^(\s*)/)[1].length;
      if (nextIndent <= indent) break;
      body.push(next);
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

check('cordis.patch.yml 含 Host 行 id: dsh-maoxuan-pet 且 name 为包名', () => {
  const bodies = patchRowBodies(patchLines, 'dsh-maoxuan-pet');
  assert.equal(bodies.length, 1, '应恰好插入一条 id: dsh-maoxuan-pet 的行');
  assert.match(bodies[0], /^\s+name:\s*['"]?dsh-plugin-maoxuan-pet['"]?\s*$/m,
    'Host 行的 name 必须是安装后的包名，否则 profile 无法解析该行');
  return true;
});

check('cordis.patch.yml 含 preset 行 id: preset-maoxuan-pet，plugins 为非空数组', () => {
  const bodies = patchRowBodies(patchLines, 'preset-maoxuan-pet');
  assert.equal(bodies.length, 1, '应恰好插入一条 id: preset-maoxuan-pet 的行');
  const body = bodies[0];
  assert.match(body, /config:\s*$/m, 'preset 行应有 config 块');
  const lines = body.split('\n');
  const pluginLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s+plugins:\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^(\s*)/)[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) continue;
      const nextIndent = next.match(/^(\s*)/)[1].length;
      if (nextIndent <= indent) break;
      if (/^\s*-\s+id:/.test(next)) pluginLines.push(next);
    }
  }
  assert.ok(pluginLines.length >= 1, 'preset 的 plugins 必须是非空数组（简易 YAML 文本断言）');
  const names = (body.match(/^\s+name:\s*['"]?(@deepseek-ai\/[^'"\s]+)['"]?\s*$/gm) ?? []);
  assert.ok(names.length >= pluginLines.length, 'plugins 里每一项都应有 @deepseek-ai/* 的 name');
  return true;
});

// --- 3. syntax checks ------------------------------------------------------
function nodeCheck(relativePath, { optional = false } = {}) {
  const target = at(relativePath);
  if (!existsSync(target)) return optional ? SKIP : assert.fail(`缺少文件：${relativePath}`);
  execFileSync(process.execPath, ['--check', relativePath], { cwd: root, stdio: 'pipe' });
  return true;
}

check('node --check index.js', () => nodeCheck('index.js'));
check('node --check verify/*.mjs（自查）', () => {
  for (const file of ['verify/smoke.mjs', 'verify/contract.mjs', 'verify/host.test.mjs']) {
    if (!existsSync(at(file))) continue;
    nodeCheck(file);
  }
  return true;
});
check('node --check client.js（缺失时 SKIP）', () => nodeCheck('client.js', { optional: true }));

// 用户反馈驱动的气泡 v2：Client 用这几个 class 组织「引文 / 小毛的话 / 启示 / 关闭」。
// 只断言 class 名存在（Structure），不写死样式文本，避免 UI 迭代时误报。
check('client.js 使用 v2 气泡结构（mp-cite / mp-pua / mp-lesson / mp-close，缺失时 SKIP）', () => {
  if (!existsSync(at('client.js'))) return SKIP;
  const client = readFileSync(at('client.js'), 'utf8');
  for (const cls of ['mp-cite', 'mp-pua', 'mp-lesson', 'mp-close']) {
    assert.ok(client.includes(cls), `client.js 缺少 v2 气泡 class：${cls}`);
  }
  return true;
});

// --- 4. contract routes ----------------------------------------------------
const contract = readFileSync(at('docs/API-CONTRACT.md'), 'utf8');
const docRoutes = [...new Set(contract.match(/\/api\/dsh-maoxuan-pet\.[a-z]+/g) ?? [])].sort();
const hostSource = readFileSync(at('index.js'), 'utf8');

check('docs/API-CONTRACT.md 声明 5 条路由', () => {
  assert.equal(docRoutes.length, 5, `文档里应恰好出现 5 条路由，实际：${docRoutes.join(', ')}`);
  return true;
});

check('index.js 中出现文档声明的每一条路由', () => {
  for (const route of docRoutes) {
    assert.ok(hostSource.includes(route), `index.js 找不到路由 ${route}`);
  }
  return true;
});

// 动态导入放在文件顶层的 await 里：ESM 支持 top-level await，且此时语法已由
// `node --check` 验证过，导入失败会直接抛出并使 smoke 失败。
const mod = await import(pathToFileURL(at('index.js')).href);
check('index.js ROUTES 与文档一致', () => {
  const exported = Object.values(mod.ROUTES ?? {}).sort();
  assert.deepEqual(exported, docRoutes, `ROUTES=${exported.join(', ')} 文档=${docRoutes.join(', ')}`);
  return true;
});

check('index.js 导出 name / inject / apply（inject 覆盖实际用到的服务）', () => {
  assert.equal(mod.name, 'dsh-maoxuan-pet');
  assert.ok(Array.isArray(mod.inject) && mod.inject.length > 0, 'inject 必须是非空数组');
  assert.ok(mod.inject.includes('connection'), "inject 必须包含 'connection'（否则无法注册 HTTP 路由）");
  for (const dep of mod.inject) {
    assert.equal(typeof dep, 'string');
    assert.ok(dep.trim().length > 0);
  }
  // Cordis 取服务前必须声明注入：代码里用了 ctx.timeout(...)，inject 就必须含 'timer'
  // （真实 `dsh web` 启动时缺这条会报 "cannot get property timer without inject"）。
  if (/ctx\.timeout\s*\(/.test(hostSource)) {
    assert.ok(mod.inject.includes('timer'), "使用 ctx.timeout() 时 inject 必须包含 'timer'");
  }
  assert.equal(typeof mod.apply, 'function');
  return true;
});

// --- 5. 语料与素材（并行工作流产物：缺失 SKIP，存在则校验） -----------------
check('corpus/index.json 结构合法（缺失时 SKIP）：version/唯一 id/verified 必须有 quote', () => {
  if (!existsSync(at('corpus/index.json'))) return SKIP;
  const index = JSON.parse(readFileSync(at('corpus/index.json'), 'utf8'));
  assert.equal(index.version, 1, 'corpus/index.json version 必须为 1');
  assert.equal(typeof index.generatedAt, 'string', 'generatedAt 必须是 ISO 字符串');
  assert.ok(Array.isArray(index.sources) && index.sources.length > 0, 'sources 不能为空');
  assert.ok(Array.isArray(index.articles) && index.articles.length > 0, 'articles 不能为空');
  const ids = new Set();
  for (const article of index.articles) {
    assert.ok(article.id && typeof article.id === 'string', 'article.id 缺失');
    assert.ok(!ids.has(article.id), `article.id 重复：${article.id}`);
    ids.add(article.id);
    assert.ok(article.title, `${article.id} 缺 title`);
    // Host 的 validateCorpus() 只强制这些；违反会让整份语料被丢弃，故为硬检查。
    if (article.verified === true) {
      assert.ok(article.quote && article.quote.trim(), `${article.id} verified=true 但 quote 为空`);
    }
  }
  return true;
});

check('corpus/index.json 内容完整度（缺失时 SKIP；并行工作流写入中仅 WARN）', () => {
  if (!existsSync(at('corpus/index.json'))) return SKIP;
  const index = JSON.parse(readFileSync(at('corpus/index.json'), 'utf8'));
  for (const article of index.articles ?? []) {
    if (!article?.id) continue;
    const summary = String(article.summary ?? '').trim();
    if (summary.length < 100) {
      warn(`corpus: ${article.id} 的 summary 为 ${summary.length} 字符（契约 §4 要求 150–250 字）`);
    }
    if (!String(article.sourceUrl ?? '').startsWith('http')) {
      warn(`corpus: ${article.id} 的 sourceUrl 不是 http(s) URL`);
    }
    // `file` is relative to corpus/ per contract §4, so the check must not
    // resolve it against the package root (that warned on every article even
    // after the 33 full texts landed).
    if (article.file && !existsSync(at('corpus', article.file))) {
      warn(`corpus: ${article.id} 的 file 不存在：corpus/${article.file}`);
    }
  }
  return true;
});

check('skill/maoxuan-vademecum/SKILL.md 存在且 ≤ 8192 字符（缺失时 SKIP）', () => {
  if (!existsSync(at('skill/maoxuan-vademecum/SKILL.md'))) return SKIP;
  const body = readFileSync(at('skill/maoxuan-vademecum/SKILL.md'), 'utf8');
  assert.match(body, /^---/, 'SKILL.md 应有 frontmatter');
  assert.match(body, /name:\s*maoxuan-vademecum/, 'frontmatter name 必须为 maoxuan-vademecum');
  assert.ok(body.length <= 8192, `SKILL.md 正文过长：${body.length} 字符`);
  return true;
});

check('assets 立绘存在（缺失时 SKIP）', () => {
  const sprites = ['pet-idle.png', 'pet-talk.png', 'pet-blink.png'];
  const missing = sprites.filter((name) => !existsSync(at('assets', name)));
  if (missing.length === sprites.length) return SKIP;
  assert.deepEqual(missing, [], `assets 缺少：${missing.join(', ')}`);
  return true;
});

// --- summary ---------------------------------------------------------------
console.log('');
for (const line of warnings) console.log(`WARN ${line}`);
if (problems.length) {
  console.error(`smoke: FAIL（${problems.length} 项失败，${checks - problems.length} 项通过，${skips} 项跳过）`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`smoke: PASS（${checks} 项通过，${skips} 项 SKIP，${warnings.length} 条 WARN）`);
console.log(`  root: ${root}`);
console.log(`  路由：${docRoutes.join(' ')}`);
