#!/usr/bin/env node
/**
 * Install / uninstall dsh-plugin-maoxuan-pet in one DSH profile.
 *
 * Why a script instead of "click install": this workspace is a plain
 * directory, not a published package, so the profile needs no registry access —
 * it needs (1) a `link:` dependency pointing at this directory and (2) this
 * package's name in `dsh.profile.bundles`, which is what composes our
 * `cordis.patch.yml` (pet row + `maoxuan-pet` agent preset).
 *
 * Usage:
 *   node install.mjs            # install into ~/.dsh/profiles/web
 *   node install.mjs --dry-run  # print the exact diff, write nothing
 *   node install.mjs --uninstall
 *   node install.mjs --profile web
 *
 * The running `dsh web` process is NOT restarted: this script is often started
 * *from* that process. Restart it yourself (Ctrl+C in the terminal running
 * `dsh web`, then `dsh web` again) after a successful install.
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return next && !next.startsWith('-') ? next : fallback;
};

const profile = valueOf('--profile', 'web');
const dryRun = flag('--dry-run');
const uninstall = flag('--uninstall');
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profile);
const manifestPath = join(profileDir, 'package.json');
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const selfName = pkg.name;

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const rel = (path) => path.replace(homedir(), '~');

let manifest;
try {
  manifest = await readJson(manifestPath);
} catch (error) {
  console.error(`✗ 读不到 profile 清单：${manifestPath}\n  ${error.message}`);
  console.error('  先运行一次 `dsh --profile web`，让 DSH 生成 profile 目录，再回来安装。');
  process.exit(1);
}

const before = JSON.stringify(manifest, null, 2);
manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {};
manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
manifest.dsh.profile.bundles = bundles;

const linkTarget = `link:${here}`;
const hasDep = Object.prototype.hasOwnProperty.call(manifest.dependencies, selfName);
const hasBundle = bundles.includes(selfName);

if (uninstall) {
  delete manifest.dependencies[selfName];
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== selfName);
} else {
  // The link target is this directory itself, so edits here are live on restart.
  manifest.dependencies[selfName] = linkTarget;
  if (!hasBundle) {
    // Keep the pet right after any existing UI bundle so its overlay row
    // composes late (overlay order inside the page is set by the slot `order`).
    const anchor = bundles.indexOf('dsh-plugin-token-burned');
    if (anchor === -1) bundles.push(selfName);
    else bundles.splice(anchor + 1, 0, selfName);
  }
  // Keep dependency keys sorted so later diffs stay readable.
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)));
}

const after = JSON.stringify(manifest, null, 2);
if (before === after) {
  console.log(`✓ ${uninstall ? '卸载' : '安装'}无变化：${profile} profile 已包含 ${selfName}`);
  process.exit(0);
}

console.log(`profile : ${rel(profileDir)}`);
console.log(`package : ${selfName}`);
console.log(`action  : ${uninstall ? 'uninstall' : 'install'}`);
console.log(`--- ${rel(manifestPath)} ---`);
console.log(after);
if (dryRun) {
  console.log('\n(dry-run) 未写入任何文件。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = `${manifestPath}.bak-maoxuan-${stamp}`;
await copyFile(manifestPath, backup);
await writeFile(manifestPath, `${after}\n`, 'utf8');
console.log(`✓ 已备份：${rel(backup)}`);

// Let DSH own the package operation: `dsh plugin` forwards to pnpm inside the
// profile directory, which is where a `link:` dependency must be materialized.
const dshBin = valueOf('--dsh-bin', 'dsh');
const install = spawnSync(dshBin, ['plugin', '--profile', profile, 'install'], {
  cwd: profileDir,
  stdio: 'inherit',
  env: process.env,
});
if (install.error) {
  console.error(`✗ 无法执行 \`${dshBin} plugin --profile ${profile} install\`：${install.error.message}`);
  console.error(`  清单已写入；请手动在该目录执行安装，然后重启 dsh web。`);
  process.exit(1);
}
if (install.status !== 0) {
  console.error(`✗ pnpm 安装失败（退出码 ${install.status}）。回滚命令：`);
  console.error(`  cp "${backup}" "${manifestPath}"`);
  process.exit(install.status ?? 1);
}

console.log('');
console.log(`✓ ${uninstall ? '卸载' : '安装'}完成。`);
console.log('  下一步：重启提供 Web GUI 的 dsh 进程（终端里 Ctrl+C，然后重新 `dsh web`），');
console.log('  重启后右下角应出现鲸鱼娘；新建会话时 preset 里选「毛选创业参谋」。');
