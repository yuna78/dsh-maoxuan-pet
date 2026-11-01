#!/usr/bin/env node
// 发布后体检：npm 元数据 + 市场（awesome-dsh-plugin）收录状态。
//
//   node scripts/post-publish-check.mjs            # 只报告，永远 exit 0（适合人工看）
//   node scripts/post-publish-check.mjs --strict   # 版本/元数据不符或市场未收录 → exit 1（适合 CI/发布门禁）
//
// 不写任何文件，不读取凭据，纯 HTTP。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const strict = process.argv.includes('--strict');
const NPM = `https://registry.npmjs.org/${pkg.name}`;
const MARKET = 'https://awesome-dsh-plugin.com/index.json';

const problems = [];
const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

console.log(`包名：${pkg.name}  本地版本：${pkg.version}`);

// 1. npm 上的真实状态
let npmData = null;
try {
  npmData = await get(NPM);
  const latest = npmData['dist-tags']?.latest ?? null;
  const version = latest ? npmData.versions?.[latest] : null;
  const repository = version?.repository?.url ?? null;
  const maintainers = (npmData.maintainers ?? []).map((m) => m.name).join(', ');
  console.log(`\n[npm] latest=${latest}  versions=${Object.keys(npmData.versions ?? {}).join(', ')}`);
  console.log(`      repository=${repository ?? '（缺失）'}`);
  console.log(`      maintainers=${maintainers}`);
  if (latest !== pkg.version) problems.push(`npm latest=${latest}，本地是 ${pkg.version}（还没发上去，或版本号没 bump）`);
  if (!repository) problems.push('npm 元数据缺 repository.url，市场页无法关联到 GitHub 仓');
  const stub = Object.keys(npmData.versions ?? {}).filter((v) => /placeholder|stage/i.test(v));
  if (stub.length) console.log(`      注意：还有占位版本 ${stub.join(', ')}，建议 npm deprecate 掉`);
} catch (error) {
  problems.push(`读 npm registry 失败：${error.message}`);
  console.log(`\n[npm] 读取失败：${error.message}`);
}

// 2. 市场索引是否收录
try {
  const market = await get(MARKET);
  const hit = (market.plugins ?? []).find((p) => p.name === pkg.name);
  if (!hit) {
    console.log(`\n[market] 尚未收录（索引共 ${(market.plugins ?? []).length} 个插件）——发布 npm 后等爬虫，通常几分钟到一天`);
    problems.push('awesome-dsh-plugin 索引里还没有这个包');
  } else {
    const versions = (hit.versions ?? []).map((v) => `${v.version}:${v.source?.type ?? '?'}`).join(', ');
    console.log(`\n[market] 已收录 title=${hit.title}`);
    console.log(`         versions=${versions}`);
    console.log(`         homepage=${hit.homepage ?? '—'}`);
    if (!versions.includes(pkg.version)) problems.push(`市场里还没有 ${pkg.version}（爬虫滞后）`);
  }
} catch (error) {
  problems.push(`读市场索引失败：${error.message}`);
  console.log(`\n[market] 读取失败：${error.message}`);
}

console.log(problems.length ? `\n结论：待处理 ${problems.length} 项\n- ${problems.join('\n- ')}` : '\n结论：全部就绪 ✅');
process.exit(strict && problems.length ? 1 : 0);
