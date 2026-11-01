#!/usr/bin/env node
/**
 * check-corpus.mjs —— 语料包契约自检（不联网）。
 *
 * 检查对象：corpus/index.json + corpus/articles/<id>.md
 * 依据：docs/API-CONTRACT.md 第 4 节「语料契约」。
 *
 * 关键检查项：每条 quote 必须能在自己那篇 md 正文里逐字找到（不跨行、不是跨段拼接），
 * 找不到就判定该条不合格 —— 这是防止"凭记忆写原文"的最后一道闸门。
 *
 * 用法：node scripts/check-corpus.mjs [--dir corpus]
 * 退出码：0 全部通过；1 有任一不合格项。
 */

import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
const CORPUS = dirIdx >= 0 ? resolve(argv[dirIdx + 1]) : join(resolve(HERE, '..'), 'corpus');

const problems = [];
const fail = (id, msg) => problems.push(`${id}: ${msg}`);

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const raw = await readFile(join(CORPUS, 'index.json'), 'utf8');
if (!raw.endsWith('\n')) fail('index.json', '文件末尾缺少换行');
if (!/"\n {2}"/.test(raw) && !raw.includes('\n  "version"')) fail('index.json', '缩进疑似不是 2 空格');
const index = JSON.parse(raw);

// ---- 顶层字段
if (index.version !== 1) fail('index.json', `version=${index.version}，应为 1`);
if (!index.generatedAt || Number.isNaN(Date.parse(index.generatedAt))) {
  fail('index.json', `generatedAt 不是合法 ISO 时间：${index.generatedAt}`);
}
if (!Array.isArray(index.sources) || index.sources.length === 0) fail('index.json', 'sources 为空');
else {
  for (const s of index.sources) {
    if (!s?.name || !/^https?:\/\//.test(s?.url || '')) fail('index.json', `sources 项不合法：${JSON.stringify(s)}`);
  }
}
if (!Array.isArray(index.articles) || index.articles.length === 0) {
  console.error('[fatal] index.json 没有 articles');
  process.exit(1);
}

// ---- 逐条
const seen = new Set();
let verifiedCount = 0;
for (const a of index.articles) {
  const id = a.id || '(missing-id)';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.id || '')) fail(id, 'id 不是 kebab-case');
  if (seen.has(a.id)) fail(id, 'id 重复');
  seen.add(a.id);

  if (!a.title) fail(id, 'title 为空');
  if (!a.year) fail(id, 'year 为空');
  if (!a.date || !/^\d{4}-\d{2}$/.test(a.date)) fail(id, `date 不是 YYYY-MM：${a.date}`);
  if (!Array.isArray(a.tags) || a.tags.length === 0) fail(id, 'tags 为空');
  if (!a.businessAngle) fail(id, 'businessAngle 为空');
  if (!/^https?:\/\//.test(a.sourceUrl || '')) fail(id, `sourceUrl 不是 http(s)：${a.sourceUrl}`);

  const summaryLen = (a.summary || '').trim().length;
  if (summaryLen < 100 || summaryLen > 400) fail(id, `summary 长度 ${summaryLen}，应为 100–400`);

  if (a.file !== `articles/${a.id}.md`) fail(id, `file 字段应为 articles/${a.id}.md，实际 ${a.file}`);
  const mdPath = join(CORPUS, a.file);
  if (!(await exists(mdPath))) {
    fail(id, `文件不存在：${a.file}`);
    continue;
  }
  const md = await readFile(mdPath, 'utf8');
  if (!md.startsWith(`# ${a.title}`)) fail(id, `md 首行不是 "# ${a.title}"`);
  if (!md.includes(a.sourceUrl)) fail(id, 'md 里没有该条 sourceUrl');
  if (!md.includes('## 资料来源')) fail(id, 'md 缺少「## 资料来源」段');

  if (!a.verified) {
    fail(id, 'verified 不为 true（契约要求进生成流程的条目必须已核验）');
    continue;
  }
  verifiedCount += 1;
  if (!a.quote || !a.quote.trim()) {
    fail(id, 'quote 为空但 verified=true');
    continue;
  }
  if (a.quote.includes('\n')) fail(id, 'quote 含换行（疑似跨段拼接）');
  if (!md.includes(a.quote)) fail(id, `quote 未在该篇 md 中逐字出现：${a.quote.slice(0, 24)}…`);
}

// ---- 报告
const total = index.articles.length;
console.log(`[check] 目录：${CORPUS}`);
console.log(`[check] generatedAt=${index.generatedAt} sources=${index.sources.length} articles=${total} verified=${verifiedCount}`);
if (problems.length === 0) {
  console.log(`[check] ✓ 全部通过：${total} 条，quote 逐字命中 ${verifiedCount} 条，字段齐全`);
  process.exit(0);
}
console.log(`[check] ✗ 发现 ${problems.length} 个问题：`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
