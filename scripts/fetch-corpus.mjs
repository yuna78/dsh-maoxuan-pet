#!/usr/bin/env node
/**
 * fetch-corpus.mjs —— 抓取中文马克思主义文库「毛泽东」公开电子文本，生成插件内置语料。
 *
 * 设计原则（为什么这么写）：
 * 1. URL 只来自目录页 https://www.marxists.org/chinese/maozedong/index.htm 的实际解析结果，
 *    白名单里写的 href 必须能在目录页里找到，否则直接报错终止 —— 从机制上杜绝"凭记忆编 URL"。
 * 2. 站点大量页面是 GB2312/GBK，统一用 gb18030 解码（它是 gb2312/gbk 的超集，不会丢字）。
 * 3. 引文（quote）不靠手写信任，而是把 md 落盘后再做一次逐字包含校验，
 *    校验通过才写 verified: true；引文为空或核不到原文就写 verified: false。
 * 4. 任何一步失败都不留半成品：先写 <file>.tmp，成功后再 rename。
 *
 * 用法：
 *   node scripts/fetch-corpus.mjs                  # 幂等抓取（已有 md 跳过），重建 index.json
 *   node scripts/fetch-corpus.mjs --force          # 强制重新抓取全部
 *   node scripts/fetch-corpus.mjs --limit 2        # 只处理前 2 篇（调试）
 *   node scripts/fetch-corpus.mjs --only id1,id2   # 只处理指定 id
 *   node scripts/fetch-corpus.mjs --offline        # 不联网，仅用已有 md 重建 index.json 并复核引文
 *   node scripts/fetch-corpus.mjs --dir /tmp/x     # 输出到别的目录（调试/试跑，不污染 corpus/）
 *
 * Node >= 20，只用标准库，无第三方依赖。
 */

import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

const INDEX_URL = 'https://www.marxists.org/chinese/maozedong/index.htm';
const ORIGIN = 'https://www.marxists.org/chinese/maozedong/';
const SOURCE_NAME = '中文马克思主义文库 · 毛泽东';
const EDITION = '据中文马克思主义文库公开电子文本整理';
const USER_AGENT =
  'dsh-maoxuan-pet-corpus/1.0 (personal study corpus builder; low rate, 1 req/' +
  '0.5s)';

const REQUEST_INTERVAL_MS = 500;
const MAX_RETRY = 3;

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = {
    force: false,
    offline: false,
    limit: 0,
    only: null,
    dir: join(PROJECT_ROOT, 'corpus'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--limit') opts.limit = Number.parseInt(argv[++i], 10) || 0;
    else if (a === '--only') {
      opts.only = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--dir') opts.dir = resolve(String(argv[++i] || ''));
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/fetch-corpus.mjs [--force] [--offline] [--limit N] [--only id1,id2] [--dir path]',
      );
      process.exit(0);
    } else {
      console.error(`[error] 未知参数：${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- 网络 + 解码

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

function decodeHtml(buffer, contentType = '') {
  // 站点 charset 声明：gb2312 / gb18030 / utf-8 都有。gb18030 是 gb2312、gbk 的超集。
  const head = new TextDecoder('latin1').decode(buffer.subarray(0, 2048));
  const meta = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() || '';
  const ct = /charset\s*=\s*([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() || '';
  const declared = meta || ct;
  if (/gb2312|gbk|gb18030/.test(declared)) {
    return new TextDecoder('gb18030').decode(buffer);
  }
  // 未声明时先按 UTF-8 严格解码，失败再退回 gb18030。
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt += 1) {
    const wait = Math.max(0, lastRequestAt + REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error(`响应过短（${buf.length} 字节），疑似错误页`);
      const html = decodeHtml(buf, res.headers.get('content-type') || '');
      if (!/<html|<\/body>/i.test(html)) throw new Error('响应不是 HTML');
      return html;
    } catch (err) {
      lastError = err;
      console.warn(`[warn] 第 ${attempt}/${MAX_RETRY} 次抓取失败 ${url}：${err.message}`);
      if (attempt < MAX_RETRY) await sleep(600 * attempt);
    }
  }
  throw new Error(`抓取失败（已重试 ${MAX_RETRY} 次）：${url} —— ${lastError?.message}`);
}

// ---------------------------------------------------------------- HTML 工具

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
  hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®', times: '×',
  divide: '÷', Oslash: 'Ø', deg: '°', laquo: '«', raquo: '»',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
        ? NAMED_ENTITIES[key]
        : whole;
    });
}

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '');

// ---------------------------------------------------------------- 目录页解析

/**
 * 解析目录页：返回 { title, items: [{ title, href, url, volume, period, index }] }
 * 结构：<h4>第X卷 … 第Y次国内革命战争时期</h4> 之后跟一个 <pre> 块，块内每行 1~2 个 <a>。
 */
function parseCatalog(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  const tokens = [...body.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>|<a\s[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const items = [];
  const seen = new Set();
  let volume = '';
  let period = '';
  for (const m of tokens) {
    if (m[1] !== undefined) {
      const text = decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim();
      const vol = /第[一二三四五六七八九十]+卷/.exec(text);
      if (vol) {
        volume = vol[0];
        period = text.slice(text.indexOf(vol[0]) + vol[0].length).trim();
      } else if (text) {
        period = text; // 例如「其它」
        if (/^其它|^PDF/.test(text)) volume = volume || '其它';
      }
      continue;
    }
    const href = m[2].trim();
    const title = decodeEntities(stripTags(m[3])).replace(/\s+/g, ' ').trim();
    // 只要篇目正文页：单篇 .htm，且不是 index/vol 目录页。
    if (!/^(?:marxist\.org-chinese-mao-|mia-chinese-mao-)[^/]+\.htm$/i.test(href)) continue;
    if (!title) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ title, href, url: new URL(href, ORIGIN).href, volume: volume || '其它', period });
  }
  // 章序号：目录里「7.　标题」的编号，取该 <a> 之前同一行最近的小序号。
  let seq = 0;
  for (const item of items) {
    const before = body.slice(Math.max(0, body.indexOf(item.href) - 40), body.indexOf(item.href));
    const num = /(\d+)\s*[.、．]\s*(?:<\/?[a-z][^>]*>)*\s*$/i.exec(before);
    item.index = num ? Number.parseInt(num[1], 10) : null;
    if (typeof item.index === 'number' && item.index > 0) seq = item.index;
    else item.index = seq;
  }
  return items;
}

// ---------------------------------------------------------------- 正文页解析

function extractPage(html) {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  const pageTitle = decodeEntities(stripTags(/<p[^>]*class=['"]title1['"][^>]*>([\s\S]*?)<\/p>/i.exec(clean)?.[1] || ''))
    .replace(/\s+/g, ' ')
    .trim();
  const pageDate = decodeEntities(stripTags(/<p[^>]*class=['"]date['"][^>]*>([\s\S]*?)<\/p>/i.exec(clean)?.[1] || ''))
    .replace(/\s+/g, ' ')
    .trim();

  // 正文：<body> 之后、第一条 <hr>（面包屑导航结束）之后开始。
  let body = clean.replace(/^[\s\S]*?<body[^>]*>/i, '');
  const navEnd = body.search(/<hr[^>]*>/i);
  if (navEnd >= 0) body = body.slice(body.indexOf('>', navEnd) + 1);

  // 去掉篇名/日期这两行（已单独取出，md 里另行渲染）。
  body = body.replace(/<p[^>]*class=['"](title1|date)['"][^>]*>[\s\S]*?<\/p>/gi, '\n');

  // 注释区（<hr> + span 10.5pt 的「注释」）整段丢弃：脚注不是正文，且会污染引文校验。
  const foot = body.search(/<hr[^>]*>\s*<span[^>]*font-size:\s*10\.5pt[\s\S]{0,80}?注释/i);
  if (foot >= 0) body = body.slice(0, foot);

  // 正文里的脚注角标 <a name='_ftnrefN'><sup>[N]</sup></a> 去掉，保持句子连续（引文可逐字 grep）。
  body = body.replace(/<a\s[^>]*name=['"]_ftnref\d+['"][^>]*>[\s\S]*?<\/a>/gi, '');

  return { pageTitle, pageDate, bodyHtml: body };
}

/** 正文 HTML → 纯文本行数组（一行 = 一个自然段） */
function htmlToLines(html) {
  let s = html;
  // 标题：内部换行合并，避免「一　没有调查」被 <br> 拆成两行
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, __, inner) => {
    const text = stripTags(String(inner).replace(/<br\s*\/?>/gi, '')).replace(/\s+/g, ' ').trim();
    return text ? `\n\n@@H@@${text}\n\n` : '\n';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>|<p\b[^>]*>/gi, '\n\n');
  s = s.replace(/<hr[^>]*>/gi, '\n\n');
  s = s.replace(/<\/?(?:div|blockquote|center|table|tbody|thead|tr|td|th|ul|ol|li|pre|span|font|b|i|u|em|strong|sup|sub|big|small|a)\b[^>]*>/gi, '');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');

  const lines = [];
  for (const raw of s.split('\n')) {
    const line = raw.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, (m) => (m.includes('\t') ? '' : ''));
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('@@H@@')) {
      lines.push({ kind: 'h', text: trimmed.slice(5).trim() });
      continue;
    }
    // 页内「〔未删节本〕某某」是兄弟篇目链接的残留（真正的未删节本是独立页面），不当正文。
    if (/^〔未删节本〕/.test(trimmed)) continue;
    // 段内换行（上一行没写句末标点、本行又不像新段）→ 拼回同一段，保证句子不被 <br> 割裂。
    const prev = lines[lines.length - 1];
    const startsIndent = /^[　\s]*/.exec(line)[0].length > 0;
    const prevOpen = prev && prev.kind === 'p' && !/[。！？…：；”』」）】]$/.test(prev.text);
    if (prevOpen && !startsIndent) {
      prev.text += trimmed;
      continue;
    }
    lines.push({ kind: 'p', text: line.replace(/^\u3000+/, '').trim() });
  }
  return lines.filter((l) => l.text);
}

// ---------------------------------------------------------------- 落盘

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

/** 抓取日期用本地日历日（避免 UTC 跨日让文档日期莫名其妙多一天）。 */
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitDateLine(raw) {
  const m = /^（[^）]*）/.exec(raw || '');
  if (!m) return { dateLine: raw || '', note: '' };
  return { dateLine: m[0], note: (raw || '').slice(m[0].length).trim() };
}

function renderMarkdown({ title, pageDate, lines, url, fetchedAt }) {
  const parts = [`# ${title}`, ''];
  const { dateLine, note } = splitDateLine(pageDate);
  if (dateLine) parts.push(`*${dateLine}*`, '');
  if (note) parts.push(`*${note}*`, '');
  for (const l of lines) {
    if (l.kind === 'h') parts.push(`## ${l.text}`, '');
    else parts.push(l.text, '');
  }
  parts.push(
    '---',
    '',
    '## 资料来源',
    '',
    `- 篇名：${title}`,
    `- 来源：${SOURCE_NAME}（${EDITION}）`,
    `- URL：${url}`,
    `- 抓取日期：${fetchedAt}`,
    '- 说明：本文件为公开电子文本的抓取结果，仅供个人学习研究使用；著作权归原作者及原出版方。',
    '',
  );
  return parts.join('\n');
}

/** 引文必须是单段、逐字出现在 md 文件里（不做空白/标点归一化，宁可判失败）。 */
function checkQuote(md, quote) {
  if (!quote) return { ok: false, reason: '未填写引文' };
  if (quote.includes('\n')) return { ok: false, reason: '引文含换行（疑似跨段拼接）' };
  if (!md.includes(quote)) return { ok: false, reason: 'md 正文中找不到该引文（非逐字）' };
  return { ok: true };
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpusDir = opts.dir;
  const articlesDir = join(corpusDir, 'articles');
  const indexPath = join(corpusDir, 'index.json');
  const metaPath = join(PROJECT_ROOT, 'scripts', 'corpus-meta.json');

  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (!Array.isArray(meta.articles) || meta.articles.length === 0) {
    throw new Error('scripts/corpus-meta.json 里没有 articles');
  }
  await mkdir(articlesDir, { recursive: true });

  // 1) 目录页：所有 URL 必须在这里面找到（防止凭记忆编 URL）
  let catalog = [];
  if (opts.offline) {
    const cached = join(corpusDir, '.catalog.json');
    if (await exists(cached)) catalog = JSON.parse(await readFile(cached, 'utf8'));
    else console.warn('[warn] --offline 且无目录缓存，跳过目录校验');
  } else {
    console.log(`[fetch] 目录页 ${INDEX_URL}`);
    const html = await fetchText(INDEX_URL);
    catalog = parseCatalog(html);
    await writeAtomic(join(corpusDir, '.catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(`[ok] 目录页解析到 ${catalog.length} 篇篇目`);
  }
  const byHref = new Map(catalog.map((it) => [it.href, it]));

  // 2) 选片
  let selected = meta.articles;
  if (opts.only) {
    const want = new Set(opts.only);
    selected = selected.filter((a) => want.has(a.id));
    const missing = [...want].filter((id) => !meta.articles.some((a) => a.id === id));
    if (missing.length) throw new Error(`--only 里的 id 不在 corpus-meta.json：${missing.join(', ')}`);
  }
  if (opts.limit > 0) selected = selected.slice(0, opts.limit);

  const fetchedAt = todayISO();
  const results = [];
  const failures = [];
  const skipped = [];

  for (const [i, entry] of selected.entries()) {
    const tag = `[${i + 1}/${selected.length}] ${entry.id}`;
    const mdPath = join(articlesDir, `${entry.id}.md`);
    const fileRel = `articles/${entry.id}.md`;

    // 目录校验：href 必须真实出现在目录页，篇名要能对上（对不上只提示，不阻断）
    let cat = null;
    if (catalog.length) {
      cat = byHref.get(entry.href);
      if (!cat) {
        const err = `目录页中找不到 href=${entry.href}（拒绝使用未经验证的 URL）`;
        failures.push({ id: entry.id, url: entry.href, error: err });
        console.error(`${tag} ✗ ${err}`);
        continue;
      }
      if (cat.title !== entry.title) {
        console.warn(`${tag} ! 目录页篇名为「${cat.title}」，meta 写的是「${entry.title}」，以目录页为准`);
      }
    }
    const title = cat?.title || (await findMdTitle(mdPath)) || entry.title;
    const url = cat?.url || new URL(entry.href, ORIGIN).href;

    let md;
    const have = await exists(mdPath);
    if (have && !opts.force) {
      md = await readFile(mdPath, 'utf8');
      skipped.push(entry.id);
      console.log(`${tag} · 已存在，跳过抓取`);
    } else if (opts.offline) {
      failures.push({ id: entry.id, url, error: '离线模式下缺少 md 文件' });
      console.error(`${tag} ✗ 离线模式下缺少 ${fileRel}`);
      continue;
    } else {
      try {
        const html = await fetchText(url);
        const { pageTitle, pageDate, bodyHtml } = extractPage(html);
        const lines = htmlToLines(bodyHtml);
        if (lines.length < 3) throw new Error(`正文解析结果过短（${lines.length} 行），疑似页面结构变化`);
        md = renderMarkdown({ title, pageDate, lines, url, fetchedAt });
        await writeAtomic(mdPath, md);
        console.log(`${tag} ✓ 已抓取 ${(md.length / 1024).toFixed(1)}KB${pageTitle && pageTitle !== title ? `（页面标题：${pageTitle}）` : ''}`);
      } catch (err) {
        failures.push({ id: entry.id, url, error: err.message });
        console.error(`${tag} ✗ ${err.message}`);
        continue; // 失败不写 index 条目，也不留半成品
      }
    }

    const quoteCheck = checkQuote(md, entry.quote || '');
    if (!quoteCheck.ok && entry.quote) {
      console.warn(`${tag} ! 引文校验未通过：${quoteCheck.reason}`);
    }
    const verified = quoteCheck.ok;
    const summary = String(entry.summary || '').trim();
    if (verified && (summary.length < 100 || summary.length > 400)) {
      console.warn(`${tag} ! summary 长度 ${summary.length}，建议 100–400 字符`);
    }
    results.push({
      id: entry.id,
      title,
      year: entry.year || '',
      date: entry.date || '',
      volume: entry.volume || cat?.volume || '',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      file: fileRel,
      sourceUrl: url,
      quote: verified ? entry.quote.trim() : '',
      summary,
      businessAngle: String(entry.businessAngle || '').trim(),
      verified,
    });
  }

  // 3) index.json（2 空格缩进、UTF-8、末尾换行）
  //    带过滤器（--limit / --only）时只更新本次涉及的条目，其余条目原样保留：
  //    否则一次调试运行就会把 index.json 截断成两三条，等于毁掉交付物。
  const filtered = Boolean(opts.only) || opts.limit > 0;
  let articles = results;
  if (filtered) {
    const previous = await readIndexArticles(indexPath);
    const touched = new Set(results.map((a) => a.id));
    const kept = previous.filter((a) => !touched.has(a.id));
    articles = [...kept, ...results];
    const order = new Map(meta.articles.map((a, i) => [a.id, i]));
    articles.sort((x, y) => (order.get(x.id) ?? 9999) - (order.get(y.id) ?? 9999));
  }
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    edition: EDITION,
    sources: [{ name: SOURCE_NAME, url: INDEX_URL }],
    articles,
  };
  await writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const verifiedCount = articles.filter((a) => a.verified).length;
  console.log(
    `\n[summary] 本次处理 ${results.length} 条 / 索引共 ${articles.length} 条（已核验 ${verifiedCount}）/ 跳过抓取 ${skipped.length} / 失败 ${failures.length}`,
  );
  console.log(`[summary] 输出目录 ${corpusDir}`);
  if (failures.length) {
    console.error('[failures]');
    for (const f of failures) console.error(`  - ${f.id} ${f.url} :: ${f.error}`);
    process.exitCode = 1;
  }
}

async function readIndexArticles(indexPath) {
  if (!(await exists(indexPath))) return [];
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'));
    return Array.isArray(parsed.articles) ? parsed.articles : [];
  } catch {
    console.warn('[warn] 已有 index.json 无法解析，将按本次结果重建');
    return [];
  }
}

async function findMdTitle(mdPath) {
  if (!(await exists(mdPath))) return null;
  const head = (await readFile(mdPath, 'utf8')).split('\n', 1)[0] || '';
  return head.startsWith('# ') ? head.slice(2).trim() : null;
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exitCode = 1;
});
