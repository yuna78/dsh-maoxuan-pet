#!/usr/bin/env node
// Corpus coverage audit: for every bundled essay, can the card actually quote it?
//   - quote   : article.quote must be verbatim in corpus/articles/<id>.md
//   - excerpt : extractExcerpt() must find a usable window (40–90 chars)
// Read-only, no network, no model calls.
// Usage: node tools/audit-corpus-coverage.mjs [--json]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clipAtBoundary, extractExcerpt, isVerbatim, LIMITS,
} from '../index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const index = JSON.parse(readFileSync(join(root, 'corpus/index.json'), 'utf8'));

const quoteFails = [];
const excerptFails = [];
const excerptLens = [];
const listy = [];

for (const article of index.articles) {
  const file = join(root, 'corpus', article.file);
  const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const quote = clipAtBoundary(article.quote, LIMITS.quote) ?? String(article.quote ?? '').slice(0, LIMITS.quote);
  if (!quote || !isVerbatim(body, quote)) quoteFails.push({ id: article.id, quote });

  const excerpt = extractExcerpt(body, 3, LIMITS.excerpt);
  if (!excerpt) excerptFails.push(article.id);
  else {
    excerptLens.push(excerpt.length);
    if (/^(?:[*\-•]|\d+[.、])/.test(excerpt)) listy.push(article.id);
  }
}

const total = index.articles.length;
const report = {
  corpus: total,
  quoteVerbatimOk: total - quoteFails.length,
  quoteVerbatimFail: quoteFails.length,
  excerptOk: excerptLens.length,
  excerptFail: excerptFails.length,
  excerptLenMin: Math.min(...excerptLens),
  excerptLenMax: Math.max(...excerptLens),
  excerptWithListMarker: listy.length,
  failures: {
    quote: quoteFails,
    excerpt: excerptFails,
    listMarker: listy,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`语料 ${total} 篇`);
  console.log(`  金句逐字命中：${report.quoteVerbatimOk}/${total}${report.quoteVerbatimFail ? `（失败 ${report.quoteVerbatimFail}）` : ''}`);
  console.log(`  节选可用：${report.excerptOk}/${total}（长度 ${report.excerptLenMin}–${report.excerptLenMax} 字，带列表符 ${report.excerptWithListMarker} 条）`);
  for (const fail of report.failures.quote) console.log(`  ✗ quote ${fail.id}: ${JSON.stringify(fail.quote).slice(0, 60)}`);
  for (const id of report.failures.excerpt) console.log(`  · excerpt ${id}: 无可用窗口（按设计降级为金句）`);
}

process.exit(report.quoteVerbatimFail === 0 ? 0 : 1);
