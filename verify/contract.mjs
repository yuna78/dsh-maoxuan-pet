#!/usr/bin/env node
/**
 * Contract unit tests for the pure helpers exported by `index.js`.
 *
 * `node verify/contract.mjs` — node:test + node:assert, no network, no `dsh`
 * subprocess, no model calls, no fixtures on disk. These lock down the
 * behaviours the Host half relies on (config normalisation, quiet window,
 * model-answer parsing, corpus validation, prompt construction), i.e. the
 * parts that are cheap to break and expensive to notice in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ROUTES, friendlyHeadlessError, extractLlmPatchEntries, headlessOverlayPath, hostPatchPath, readCredentialRefs, childHeadlessEnv, normaliseConfig, resolveDshHome, resolveStatePath, isQuietAt, quietEnd, startOfLocalDay, stripFrontmatter, extractJson, TEMPLATES, TEMPLATE_LABEL, AXES, MAX_BUBBLE_CHARS, LIMITS, isVerbatim, clipAtBoundary, extractExcerpt, pickTemplate, deriveAxis, normaliseGenerated, fitLesson, migrateBubble, longestSharedRun, offlineBubble, buildPrompt, pickArticle, validateCorpus, LEGACY_AXES, coerceAxis } from '../index.js';

/** Local-time helper: avoids UTC/local confusion in the quiet-window tests. */
const local = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
// 2026-01-15 is far from any DST transition in the zones this repo runs in.
const JAN = [2026, 1, 15];

const article = (overrides = {}) => ({
  id: 'fan-dui-ben-ben-zhu-yi',
  title: '反对本本主义',
  year: '1930年5月',
  quote: '没有调查，没有发言权。',
  summary: '当时红军中有人靠本本和上级指示办事，作者主张先做社会调查再下判断。',
  businessAngle: '把“我觉得用户需要”换成一次可验证的访谈。',
  sourceUrl: 'https://www.marxists.org/chinese/maozedong/marxist.org-chinese-mao-193005.htm',
  ...overrides,
});

/**
 * 一篇最小的“正文”：第 2、3 段都 ≥40 字（extractExcerpt 的入选门槛），
 * 第 2 段包含 article().quote 的逐字原句，末段是必须被跳过的来源段。
 */
const BODY = [
  '# 反对本本主义',
  '',
  '没有调查，没有发言权。这是原文里的一句，用来测试逐字校验与节选窗口的提取，长度需要超过四十个字符才行。',
  '',
  '第二段正文也不短，同样超过四十个字符，用于种子轮换测试，再补几个字凑够长度，确保能被选中。',
  '',
  '资料来源：https://www.marxists.org/chinese/maozedong/marxist.org-chinese-mao-193005.htm',
].join('\n');

// ---------------------------------------------------------------------------
// normaliseConfig
// ---------------------------------------------------------------------------
test('normaliseConfig: 空配置返回契约 §2 的默认值', () => {
  const cfg = normaliseConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.everySeconds, 3600);
  assert.equal(cfg.firstDelaySeconds, 90);
  assert.deepEqual(cfg.quietHours, [2, 8]);
  assert.equal(cfg.maxBubbles, 40);
  assert.equal(cfg.headless, true);
  assert.equal(cfg.dshBin, 'dsh');
  assert.equal(cfg.profile, 'headless');
  assert.equal(cfg.timeoutMs, 180000);
  assert.equal(cfg.businessContext, '');
  assert.equal(cfg.modelHint, '');
  assert.equal(typeof cfg.dailyLimit, 'number');
  assert.ok(cfg.dailyLimit >= 0);
});

test('llm 桥接 (v0.2.3): 宿主 patch 的 llm 行原样抽出，无关行不动', () => {
  const sample = [
    '- id: ui-settings-general',
    '  name: "@x/y"',
    '  config: {hello: 1}',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: wocheng',
    '    model: gpt-6.1-sol',
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      wocheng:',
    '        apiKeyEnv: WOCHENG_API_KEY',
    '- insert:',
    '    - id: something',
    '      name: unrelated',
    '- id: llm-deepseek',
    '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
    '  config:',
    '    baseURL: https://api.deepseek.com/v1',
    '',
  ].join('\n');
  const entries = extractLlmPatchEntries(sample);
  assert.equal(entries.length, 3);
  assert.match(entries[0], /agent-default-model/);
  assert.match(entries[0], /model: gpt-6\.1-sol/);
  assert.match(entries[1], /WOCHENG_API_KEY/);
  assert.match(entries[2], /dsh-llm-deepseek-api-key/);
  assert.ok(!entries.some((e) => e.includes('unrelated')), '无关条目不被搬运');
  assert.deepEqual(extractLlmPatchEntries('- a: 1\n- b: 2'), [], '无 llm 条目时返回空');
  assert.deepEqual(extractLlmPatchEntries(''), [], '空文件返回空');
});

test('normaliseConfig: 用户配置被保留，字符串去空白', () => {
  const cfg = normaliseConfig({
    enabled: false,
    everySeconds: 600,
    firstDelaySeconds: 5,
    quietHours: [22, 7],
    maxBubbles: 5,
    headless: false,
    dshBin: '  /usr/local/bin/dsh  ',
    profile: ' work ',
    timeoutMs: 20000,
    businessContext: '  卖 SaaS 的小团队  ',
    modelHint: '  毒舌一点  ',
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.everySeconds, 600);
  assert.equal(cfg.firstDelaySeconds, 5);
  assert.deepEqual(cfg.quietHours, [22, 7]);
  assert.equal(cfg.maxBubbles, 5);
  assert.equal(cfg.headless, false);
  assert.equal(cfg.dshBin, '/usr/local/bin/dsh');
  assert.equal(cfg.profile, 'work');
  assert.equal(cfg.timeoutMs, 20000);
  assert.equal(cfg.businessContext, '卖 SaaS 的小团队');
  assert.equal(cfg.modelHint, '毒舌一点');
});

test('normaliseConfig: 数值越界被钳制到安全区间', () => {
  assert.equal(normaliseConfig({ everySeconds: 10 }).everySeconds, 60, '最小 60s');
  assert.equal(normaliseConfig({ everySeconds: 8 * 24 * 3600 }).everySeconds, 7 * 24 * 3600, '最大 7 天');
  assert.equal(normaliseConfig({ firstDelaySeconds: 0 }).firstDelaySeconds, 1);
  assert.equal(normaliseConfig({ firstDelaySeconds: 99999 }).firstDelaySeconds, 3600);
  assert.equal(normaliseConfig({ maxBubbles: 0 }).maxBubbles, 1);
  assert.equal(normaliseConfig({ maxBubbles: 9999 }).maxBubbles, 500);
  assert.equal(normaliseConfig({ timeoutMs: 1 }).timeoutMs, 10000);
  assert.equal(normaliseConfig({ timeoutMs: 10 ** 9 }).timeoutMs, 900000);
});

test('normaliseConfig: 非法/无关输入回落到默认值而不是抛错', () => {
  assert.equal(normaliseConfig({ everySeconds: 'abc' }).everySeconds, 3600);
  assert.equal(normaliseConfig({ enabled: 'no' }).enabled, true, 'enabled 只认字面 false');
  assert.equal(normaliseConfig({ headless: 'yes' }).headless, true, 'headless 只认字面 false');
  assert.equal(normaliseConfig({ dshBin: '   ' }).dshBin, 'dsh');
  assert.equal(normaliseConfig(null).everySeconds, 3600);
  assert.equal(normaliseConfig('not-an-object').everySeconds, 3600);
});

test('normaliseConfig: null / undefined / 空字符串视为“未配置”，回落默认值（回归）', () => {
  // YAML 里写 `maxBubbles:`（空值）会得到 null；修复前 Number(null)===0 会被钳到
  // 最小值（历史气泡只剩 1 条），现在必须回落到默认值。
  assert.equal(normaliseConfig({ maxBubbles: null }).maxBubbles, 40);
  assert.equal(normaliseConfig({ maxBubbles: '' }).maxBubbles, 40);
  assert.equal(normaliseConfig({ maxBubbles: undefined }).maxBubbles, 40);
  assert.equal(normaliseConfig({ everySeconds: null }).everySeconds, 3600);
  assert.equal(normaliseConfig({ everySeconds: '' }).everySeconds, 3600);
  assert.equal(normaliseConfig({ firstDelaySeconds: '' }).firstDelaySeconds, 90);
  assert.equal(normaliseConfig({ timeoutMs: null }).timeoutMs, 180000);
  assert.equal(normaliseConfig({ dailyLimit: null }).dailyLimit, 24);
  assert.deepEqual(normaliseConfig({ quietHours: [null, null] }).quietHours, [2, 8]);
  assert.deepEqual(normaliseConfig({ quietHours: ['', ''] }).quietHours, [2, 8]);
  // 数字 0 是合法输入，仍应钳到最小值，而不是被当成“未配置”。
  assert.equal(normaliseConfig({ maxBubbles: 0 }).maxBubbles, 1);
  assert.equal(normaliseConfig({ everySeconds: 0 }).everySeconds, 60);
});

test('normaliseConfig: quietHours 容错（长度、类型、越界）', () => {
  assert.deepEqual(normaliseConfig({ quietHours: [1, 7] }).quietHours, [1, 7]);
  assert.deepEqual(normaliseConfig({ quietHours: [1] }).quietHours, [2, 8], '长度不为 2 时用默认窗口');
  assert.deepEqual(normaliseConfig({ quietHours: 'nope' }).quietHours, [2, 8]);
  const off = normaliseConfig({ quietHours: ['x', 25] }).quietHours;
  assert.equal(off[0], 2, '非数字起始小时回落到默认值');
  assert.ok(off[1] >= 0 && off[1] <= 23, `结束小时必须落在 0–23，实际 ${off[1]}`);
  const clamp = normaliseConfig({ quietHours: [-5, 12] }).quietHours;
  assert.equal(clamp[0], 0, '负数小时钳制到 0');
});

// ---------------------------------------------------------------------------
// 路径解析（契约 §1：配置目录名）
// ---------------------------------------------------------------------------
test('resolveDshHome / resolveStatePath: 默认目录与 env 覆盖', () => {
  assert.equal(resolveDshHome({ DSH_HOME: ' /tmp/dsh-home ' }), '/tmp/dsh-home');
  assert.equal(resolveDshHome({ HOME: '/home/dev' }), '/home/dev/.dsh');

  const defaultPath = resolveStatePath({ HOME: '/home/dev' });
  assert.equal(defaultPath, join('/home/dev', '.dsh', 'storages', 'dsh-maoxuan-pet.json'),
    '契约 §1 要求状态落在 $DSH_HOME/storages/dsh-maoxuan-pet.json');

  assert.equal(resolveStatePath({ DSH_HOME: '/tmp/dsh-home' }),
    join('/tmp/dsh-home', 'storages', 'dsh-maoxuan-pet.json'));

  // 测试与隔离 profile 用的显式覆盖优先级最高。
  assert.equal(resolveStatePath({ DSH_MAOXUAN_PET_STATE: ' /tmp/pet.json ', DSH_HOME: '/x' }), '/tmp/pet.json');
  assert.equal(resolveStatePath({ DSH_MAOXUAN_PET_STATE: '  ', DSH_HOME: '/x' }),
    join('/x', 'storages', 'dsh-maoxuan-pet.json'), '空白覆盖值应被忽略');
});

// ---------------------------------------------------------------------------
// 静默时段
// ---------------------------------------------------------------------------
test('isQuietAt: 普通窗口 [2,8) 左闭右开', () => {
  const window = [2, 8];
  assert.equal(isQuietAt(local(...JAN, 1, 59), window), false);
  assert.equal(isQuietAt(local(...JAN, 2, 0), window), true);
  assert.equal(isQuietAt(local(...JAN, 7, 59), window), true);
  assert.equal(isQuietAt(local(...JAN, 8, 0), window), false, '结束小时不算静默');
  assert.equal(isQuietAt(local(...JAN, 13, 0), window), false);
});

test('isQuietAt: 跨零点窗口 [22,7)', () => {
  const window = [22, 7];
  assert.equal(isQuietAt(local(...JAN, 21, 59), window), false);
  assert.equal(isQuietAt(local(...JAN, 22, 0), window), true);
  assert.equal(isQuietAt(local(...JAN, 23, 30), window), true);
  assert.equal(isQuietAt(local(...JAN, 0, 30), window), true);
  assert.equal(isQuietAt(local(...JAN, 6, 59), window), true);
  assert.equal(isQuietAt(local(...JAN, 7, 0), window), false);
  assert.equal(isQuietAt(local(...JAN, 12, 0), window), false);
});

test('isQuietAt / quietEnd: start==end 表示“永不静默”', () => {
  const window = [5, 5];
  for (const hour of [0, 5, 12, 23]) {
    assert.equal(isQuietAt(local(...JAN, hour), window), false, `${hour} 点不应静默`);
    assert.equal(quietEnd(local(...JAN, hour), window).getTime(), local(...JAN, hour).getTime(),
      '永不静默时 quietEnd 原样返回');
  }
});

test('quietEnd: [2,8) 之内返回当天 08:00，之外原样返回', () => {
  assert.equal(quietEnd(local(...JAN, 3, 30), [2, 8]).getTime(), local(...JAN, 8, 0).getTime());
  assert.equal(quietEnd(local(...JAN, 2, 0), [2, 8]).getTime(), local(...JAN, 8, 0).getTime());
  const outside = local(...JAN, 9, 15);
  assert.equal(quietEnd(outside, [2, 8]).getTime(), outside.getTime());
});

test('quietEnd: 跨零点窗口 [22,7) 从当晚报到次日 07:00，凌晨当日报 07:00', () => {
  assert.equal(quietEnd(local(...JAN, 23, 10), [22, 7]).getTime(), local(2026, 1, 16, 7).getTime());
  assert.equal(quietEnd(local(...JAN, 0, 30), [22, 7]).getTime(), local(2026, 1, 15, 7).getTime());
  assert.equal(quietEnd(local(...JAN, 6, 0), [22, 7]).getTime(), local(2026, 1, 15, 7).getTime());
  const daytime = local(...JAN, 12, 0);
  assert.equal(quietEnd(daytime, [22, 7]).getTime(), daytime.getTime());
});

test('startOfLocalDay: 返回本地零点', () => {
  assert.equal(startOfLocalDay(local(...JAN, 23, 59)), local(...JAN, 0, 0).getTime());
  assert.equal(startOfLocalDay(local(...JAN, 0, 0)), local(...JAN, 0, 0).getTime());
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------
test('extractJson: 纯 JSON / 围栏 / 前后废话都能取到对象', () => {
  assert.deepEqual(extractJson('{"thought":"a"}'), { thought: 'a' });
  assert.deepEqual(extractJson('```json\n{"thought":"a"}\n```'), { thought: 'a' });
  assert.deepEqual(extractJson('```\n{"thought":"b"}\n```'), { thought: 'b' });
  assert.deepEqual(extractJson('好的，这是我给的答案：{"thought":"c","tone":"sharp"} 希望有用'),
    { thought: 'c', tone: 'sharp' });
  assert.deepEqual(extractJson('前缀\n{"a":{"b":1}}\n后缀'), { a: { b: 1 } });
});

test('extractJson: 坏输入返回 null（调用方据此降级为离线摘录）', () => {
  assert.equal(extractJson('not json at all'), null);
  assert.equal(extractJson('{"thought":'), null);
  assert.equal(extractJson('{"a":1} {"b":2}'), null, '两个对象拼在一起不是合法 JSON');
  // 贪婪切片的既有行为：末尾残缺对象不会阻止前面完整对象的解析。
  assert.deepEqual(extractJson('{"a":1} tail {"b":2'), { a: 1 });
  assert.equal(extractJson('[1,2,3]'), null, '数组不是契约对象');
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
});

// ---------------------------------------------------------------------------
// v2 常量（契约 §3 Bubble 结构 v2）
// ---------------------------------------------------------------------------
test('TEMPLATES / TEMPLATE_LABEL / AXES / MAX_BUBBLE_CHARS / LIMITS 与契约一致', () => {
  assert.deepEqual(TEMPLATES, ['quote', 'excerpt', 'summary']);
  assert.deepEqual(TEMPLATE_LABEL, { quote: '原文', excerpt: '节选', summary: '小毛概括' });
  assert.deepEqual(AXES, ['客户', '项目', '组织', '现金流', '决策', '自律'], '用户裁决：人事 → 组织');
  assert.deepEqual(LEGACY_AXES, { 人事: '组织' }, '旧名字保留迁移映射');
  assert.equal(MAX_BUBBLE_CHARS, 200, '用户硬约束：一条气泡 ≤200 字');
  assert.deepEqual(LIMITS, { quote: 70, excerpt: 90, summary: 70, pua: 40, lesson: 100 });
});

// ---------------------------------------------------------------------------
// isVerbatim
// ---------------------------------------------------------------------------
test('isVerbatim: 命中 / 改写不命中 / 空白折叠', () => {
  assert.equal(isVerbatim(BODY, '没有调查，没有发言权。'), true);
  assert.equal(isVerbatim(BODY, '没有调查，没有发言权'), true, '子串命中');
  // 折叠空白：正文里的换行/连续空格与 needle 里的一个空格等价。
  assert.equal(isVerbatim('没有调查，没有\n发言权。', '没有调查，没有 发言权。'), true);
  assert.equal(isVerbatim('没有调查，没有  发言权。', '没有调查，没有\n发言权。'), true);
  assert.equal(isVerbatim(BODY, '没有调查，就一定有发言权。'), false, '改写过的句子不得命中');
  assert.equal(isVerbatim(BODY, ''), false);
  assert.equal(isVerbatim('', '没有调查'), false);
  assert.equal(isVerbatim(null, '没有调查'), false);
});

// ---------------------------------------------------------------------------
// clipAtBoundary
// ---------------------------------------------------------------------------
test('clipAtBoundary: 在句读处切，切不动返回 null', () => {
  assert.equal(clipAtBoundary('今天先做一件事。明天再想别的。', 10), '今天先做一件事。', '优先句号');
  assert.equal(clipAtBoundary('第一步先做，第二步再慢慢说。', 10), '第一步先做，', '退而求其次用逗号');
  assert.equal(clipAtBoundary('短句。', 10), '短句。', '不超过上限时原样返回');
  assert.equal(clipAtBoundary('abcdefghijklmnopqrstuvwxyz', 10), null, '窗口内没有句读 → null');
  assert.equal(clipAtBoundary(`短，${'x'.repeat(60)}`, 40), null, '切点太靠前（<12 字）宁可不切');
  assert.equal(clipAtBoundary('  今天  先做一件事。  ', 10), '今天 先做一件事。', '先折叠空白');
  assert.equal(clipAtBoundary('', 10), '', '空串原样返回');
});

// ---------------------------------------------------------------------------
// extractExcerpt
// ---------------------------------------------------------------------------
test('extractExcerpt: 逐字整句窗口、≤ 上限、种子轮换', () => {
  const excerpt = extractExcerpt(BODY, 0, LIMITS.excerpt);
  assert.ok(excerpt, '有正文时应取到节选');
  assert.ok(excerpt.length <= LIMITS.excerpt, `节选不得超过 ${LIMITS.excerpt} 字，实际 ${excerpt.length}`);
  assert.equal(isVerbatim(BODY, excerpt), true, '节选必须逐字来自正文');
  assert.match(excerpt, /[。！？；]$/, '在句末收尾，不在句子中间切');

  const other = extractExcerpt(BODY, 1, LIMITS.excerpt);
  assert.ok(other && other !== excerpt, '不同种子应换段落');
  assert.equal(isVerbatim(BODY, other), true);

  const smaller = extractExcerpt(BODY, 0, 45);
  assert.ok(smaller && smaller.length <= 45, 'max 参数生效');
});

test('extractExcerpt: 太短 / 空正文 / 只有来源段时返回 null', () => {
  assert.equal(extractExcerpt('太短', 0, LIMITS.excerpt), null);
  assert.equal(extractExcerpt('', 0, LIMITS.excerpt), null);
  assert.equal(extractExcerpt(null, 0, LIMITS.excerpt), null);
  const sourceOnly = '资料来源：https://example.invalid/一个足够长的来源行，用来确认来源段不会被当成节选取出来。';
  assert.equal(extractExcerpt(sourceOnly, 0, LIMITS.excerpt), null);
});

// ---------------------------------------------------------------------------
// pickTemplate / deriveAxis
// ---------------------------------------------------------------------------
test('pickTemplate: quote → excerpt → summary 轮转', () => {
  assert.equal(pickTemplate(0), 'quote');
  assert.equal(pickTemplate(1), 'excerpt');
  assert.equal(pickTemplate(2), 'summary');
  assert.equal(pickTemplate(3), 'quote', '循环回到金句');
  assert.equal(pickTemplate(4), 'excerpt');
  assert.equal(pickTemplate(-1), 'excerpt', '负数取绝对值');
  assert.equal(pickTemplate(Number.NaN), 'quote');
  assert.equal(pickTemplate(undefined), 'quote');
});

test('deriveAxis: 由 tags 推落点，未知/缺失回落到“决策”', () => {
  const cases = [
    [['调查研究'], '决策'],
    [['实践'], '决策'],
    [['群众工作'], '组织'],
    [['经济', '财政'], '现金流'],
    [['战争', '战略'], '项目'],
    [['阶级'], '客户'],
    [['随手写的'], '决策'],
  ];
  for (const [tags, axis] of cases) {
    assert.equal(deriveAxis({ tags }), axis, `tags=${tags.join(',')} 应推导出 ${axis}`);
    assert.ok(AXES.includes(deriveAxis({ tags })), '推导结果必须落在 AXES 内');
  }
  assert.equal(deriveAxis({}), '决策');
  assert.equal(deriveAxis(null), '决策');
});

// ---------------------------------------------------------------------------
// normaliseGenerated（v2）
// ---------------------------------------------------------------------------
test('normaliseGenerated: v2 合法答案裁剪为 pua/lesson/axis/gist/tone', () => {
  const result = normaliseGenerated({
    pua: '  别把“在忙”当进度。 ',
    lesson: ' 先做一件能拿到反馈的事，再复盘。 ',
    axis: '组织',
    gist: ' 这篇文章讲的是先调查再判断。 ',
    tone: 'urgent',
  });
  assert.deepEqual(result, {
    pua: '别把“在忙”当进度。',
    lesson: '先做一件能拿到反馈的事，再复盘。',
    axis: '组织',
    gist: '这篇文章讲的是先调查再判断。',
    tone: 'urgent',
  });
});

test('normaliseGenerated: 缺 lesson 返回 null（Host 据此降级 offline）', () => {
  assert.equal(normaliseGenerated({ pua: '有督促' }), null);
  assert.equal(normaliseGenerated({ pua: '有督促', lesson: '   ' }), null, '全空白等同缺失');
  assert.equal(normaliseGenerated({}), null);
  assert.equal(normaliseGenerated(null), null);
  assert.equal(normalizeFailSafe(), null);
  const noLesson = normaliseGenerated({ pua: '有督促', lesson: undefined });
  assert.equal(noLesson, null);
});

/**
 * 现状与 lead 的 v2 说明存在一处差异（已报 lead）：
 * 说明写“缺 pua 或 lesson 返回 null”，实现里 pua 是**可选**的（模型复述原文时
 * runOnce 会整条丢弃 pua，见 longestSharedRun），所以这里按实现断言 pua 可为空。
 * 若 lead 决定恢复“pua 必填”，把这条收紧成 assert.equal(..., null) 即可。
 */
function normalizeFailSafe() {
  return normaliseGenerated({ pua: '有督促', lesson: '' });
}

test('normaliseGenerated: pua 可选——模型只给 lesson 时不报 null 而是空 pua（契约 §3 已明确）', () => {
  const result = normaliseGenerated({ lesson: '有启示' });
  assert.ok(result, 'pua 缺失不再整体作废');
  assert.equal(result.pua, '', '空 pua 由 Client 不渲染，Host 不伪造');
  assert.equal(result.lesson, '有启示');
  assert.equal(result.axis, '项目');
  assert.equal(result.tone, 'sharp');
  const noPua = normaliseGenerated({ pua: '   ', lesson: '有启示' });
  assert.equal(noPua.pua, '');
});

test('longestSharedRun: 识别复述原文的最长公共串（runOnce 用 ≥8 判定回声）', () => {
  assert.equal(longestSharedRun('没有调查就没有发言权', '没有调查就没有发言权'), 10);
  assert.equal(longestSharedRun('今天先做一件事', '先做一件事再复盘'), 5, '公共子串“先做一件事”');
  assert.equal(longestSharedRun('完全不同的两句话', '另一句不相干的话'), 1);
  assert.equal(longestSharedRun('', 'x'), 0);
  assert.equal(longestSharedRun(null, 'x'), 0);
  assert.equal(longestSharedRun('abc', 'abc'), 3);
});

test('normaliseGenerated: 非法 axis/tone 回落，缺 gist 为空串', () => {
  const fallback = normaliseGenerated({ pua: '说一句', lesson: '做一件' });
  assert.equal(fallback.axis, '项目');
  assert.equal(fallback.tone, 'sharp');
  assert.equal(fallback.gist, '');
  const invalid = normaliseGenerated({ pua: 'a', lesson: 'b', axis: '不存在', tone: '温柔' });
  assert.equal(invalid.axis, '项目');
  assert.equal(invalid.tone, 'sharp');
});

test('normaliseGenerated: pua ≤40、lesson ≤100 且尽量在句读处截断', () => {
  const long = normaliseGenerated({
    pua: '说'.repeat(80),
    lesson: '第一句启示写得比较长。'.repeat(30),
    axis: '客户',
  });
  assert.equal(long.pua.length, LIMITS.pua);
  assert.ok(long.lesson.length <= LIMITS.lesson);
  assert.match(long.lesson, /。$/, '按句读截断应保留句末标点');
  const longGist = normaliseGenerated({ pua: 'a', lesson: 'b', gist: '概'.repeat(200) });
  assert.equal(longGist.gist.length, LIMITS.summary);
});

// ---------------------------------------------------------------------------
// fitLesson
// ---------------------------------------------------------------------------
test('fitLesson: cite + pua + lesson 合计 ≤200 字，超出时按句读截 lesson', () => {
  const cite = '引'.repeat(LIMITS.excerpt); // 90
  const pua = '说'.repeat(LIMITS.pua);      // 40
  const fitted = fitLesson(cite, pua, '启示句。'.repeat(50));
  assert.ok(fitted.chars <= MAX_BUBBLE_CHARS, `chars 必须 ≤200，实际 ${fitted.chars}`);
  assert.equal(fitted.chars, cite.length + pua.length + fitted.lesson.length);
  assert.ok(fitted.lesson.length > 0);
  assert.match(fitted.lesson, /。$/, '优先在句读处截断');

  const short = fitLesson('短引文。', '短pua。', '一条能落地的规则。');
  assert.equal(short.lesson, '一条能落地的规则。', '正常长度不改写');
  assert.equal(short.chars, '短引文。'.length + '短pua。'.length + short.lesson.length);

  const noBoundary = fitLesson('短引文。', '短pua。', 'x'.repeat(300));
  assert.ok(noBoundary.lesson.length <= LIMITS.lesson);
  assert.ok(noBoundary.chars <= MAX_BUBBLE_CHARS);
});

// ---------------------------------------------------------------------------
// migrateBubble
// ---------------------------------------------------------------------------
test('migrateBubble: v1（thought/insight/nag/action）映射为 v2，且幂等', () => {
  const v1 = {
    id: 'b-20261031T000000-abcd',
    at: '2026-10-31T00:00:00.000Z',
    read: false,
    mode: 'offline',
    articleId: 'fan-dui-ben-ben-zhu-yi',
    title: '反对本本主义',
    year: '1930年5月',
    quote: '没有调查，没有发言权。',
    sourceUrl: 'https://example.invalid/x',
    thought: '思想',
    insight: '启示',
    nag: '督促',
    action: '动作',
    tone: 'sharp',
  };
  const v2 = migrateBubble(v1);
  assert.equal(v2.template, 'quote');
  assert.equal(v2.cite.kind, 'quote');
  assert.equal(v2.cite.label, '原文');
  assert.equal(v2.cite.text, '没有调查，没有发言权。');
  assert.equal(v2.pua, '督促');
  assert.equal(v2.lesson, '启示');
  assert.equal(v2.axis, '项目');
  assert.equal(v2.mode, 'offline');
  assert.equal(v2.tone, 'sharp');
  assert.equal(v2.id, v1.id);
  assert.equal(v2.at, v1.at);
  assert.equal(v2.read, false);
  assert.ok(v2.chars <= MAX_BUBBLE_CHARS);
  assert.equal(v2.chars, v2.cite.text.length + v2.pua.length + v2.lesson.length);

  assert.equal(migrateBubble(v2), v2, '已是 v2 时原样返回（幂等，loadState 每次启动都会跑）');
  assert.equal(migrateBubble(null), null);

  // 用户把落点「人事」改成「组织」：旧名字必须迁移，不能退化成默认值。
  const legacy = migrateBubble({ ...v2, axis: '人事' });
  assert.equal(legacy.axis, '组织');
  assert.equal(legacy.id, v2.id);
  assert.equal(migrateBubble(legacy), legacy, '迁移后再次读取仍是幂等');
  assert.equal(coerceAxis('人事'), '组织');
  assert.equal(coerceAxis('组织'), '组织');
  assert.equal(coerceAxis('胡说'), null);

  const noQuote = migrateBubble({ ...v1, quote: '', thought: '旧的思想' });
  assert.equal(noQuote.template, 'summary');
  assert.equal(noQuote.cite.text, '旧的思想');
  assert.equal(noQuote.cite.label, '小毛概括');
});

// ---------------------------------------------------------------------------
// offlineBubble（v2 签名：article, body, template, now）
// ---------------------------------------------------------------------------
test('offlineBubble v2: quote / excerpt / summary 三种模板都给出可核的 cite 与完整字段', () => {
  const now = local(...JAN, 12);

  const quote = offlineBubble(article(), BODY, 'quote', now);
  assert.equal(quote.mode, 'offline');
  assert.equal(quote.template, 'quote');
  assert.equal(quote.cite.kind, 'quote');
  assert.equal(quote.cite.label, '原文');
  assert.equal(quote.cite.text, '没有调查，没有发言权。');
  assert.equal(isVerbatim(BODY, quote.cite.text), true, '金句必须逐字来自语料正文');
  assert.ok(AXES.includes(quote.axis));
  assert.ok(quote.pua.length > 0 && quote.pua.length <= LIMITS.pua);
  assert.ok(quote.lesson.length > 0 && quote.lesson.length <= LIMITS.lesson);
  assert.ok(quote.chars <= MAX_BUBBLE_CHARS);
  assert.equal(quote.chars, quote.cite.text.length + quote.pua.length + quote.lesson.length);
  assert.equal(quote.tone, 'calm');

  const excerpt = offlineBubble(article(), BODY, 'excerpt', now);
  assert.equal(excerpt.template, 'excerpt');
  assert.equal(excerpt.cite.kind, 'excerpt');
  assert.equal(excerpt.cite.label, '节选');
  assert.equal(isVerbatim(BODY, excerpt.cite.text), true, '节选必须逐字来自语料正文');
  assert.ok(excerpt.cite.text.length <= LIMITS.excerpt);
  assert.ok(excerpt.chars <= MAX_BUBBLE_CHARS);

  const summary = offlineBubble(article(), BODY, 'summary', now);
  assert.equal(summary.template, 'summary');
  assert.equal(summary.cite.kind, 'summary');
  assert.equal(summary.cite.label, '小毛概括');
  assert.equal(summary.cite.text, '当时红军中有人靠本本和上级指示办事，作者主张先做社会调查再下判断。',
    '概括模式取语料 summary 的首句');
  assert.notEqual(summary.cite.text, article().title, '概括模式不得只给篇名');
  assert.ok(summary.chars <= MAX_BUBBLE_CHARS);
});

test('offlineBubble v2: 未知模板回落 quote；excerpt 无正文时退 summary', () => {
  const now = local(...JAN, 12);
  const bogus = offlineBubble(article(), BODY, 'bogus', now);
  assert.equal(bogus.template, 'quote');
  assert.equal(bogus.cite.label, '原文');

  const noBody = offlineBubble(article(), '', 'excerpt', now);
  assert.equal(noBody.template, 'summary', '取不到逐字节选就退概括，不能伪造节选');
  assert.equal(noBody.cite.kind, 'summary');
  assert.ok(noBody.cite.text.length > 0);
  assert.ok(noBody.chars <= MAX_BUBBLE_CHARS);
});

// ---------------------------------------------------------------------------
// buildPrompt（v2）
// ---------------------------------------------------------------------------
test('buildPrompt v2: 要求 pua/lesson/axis，带 200 字硬约束，不再要 v1 字段', () => {
  const prompt = buildPrompt(article(), {
    businessContext: '个体开发者，现金流紧张',
    modelHint: '短句，别用套话',
  });
  for (const key of ['"pua"', '"lesson"', '"axis"']) {
    assert.ok(prompt.includes(key), `prompt 缺少 ${key}`);
  }
  for (const oldKey of ['"thought"', '"insight"', '"nag"', '"action"']) {
    assert.equal(prompt.includes(oldKey), false, `prompt 不应再要求 v1 字段 ${oldKey}`);
  }
  assert.ok(prompt.includes('反对本本主义'), 'prompt 必须带篇名');
  assert.ok(prompt.includes('没有调查，没有发言权。'), 'prompt 必须带已核对的金句');
  assert.ok(prompt.includes('个体开发者，现金流紧张'));
  assert.ok(prompt.includes('短句，别用套话'));
  assert.ok(prompt.includes('不超过 200 字'), '必须写明 200 字硬上限');
  assert.ok(prompt.includes('不要改写、不要编造毛选原文'));
  assert.ok(prompt.includes('不把客户、员工或竞争者称为敌人'));
});

test('buildPrompt v2: 模板影响 prompt（summary 要 gist、excerpt 带节选原文）', () => {
  const summaryPrompt = buildPrompt(article(), { template: 'summary' });
  assert.ok(summaryPrompt.includes('"gist"'), 'summary 模式必须要求模型给 gist');
  assert.equal(summaryPrompt.includes('本期给你的节选'), false);

  const excerptPrompt = buildPrompt(article(), { template: 'excerpt', excerpt: '某段节选原文' });
  assert.ok(excerptPrompt.includes('某段节选原文'));
  assert.ok(excerptPrompt.includes('本期给你的节选'));
  assert.equal(excerptPrompt.includes('"gist"'), false, 'excerpt 模式不需要 gist');

  const quotePrompt = buildPrompt(article(), { template: 'quote' });
  assert.equal(quotePrompt.includes('本期给你的节选'), false);
});

test('buildPrompt v2: axis 决定启示落点提示；缺省时给出全部可选落点', () => {
  assert.ok(buildPrompt(article(), { axis: '组织' }).includes('招人、分工、协作、复盘问责'));
  assert.ok(buildPrompt(article(), { axis: '现金流' }).includes('回款、成本、定价、活下来的余量'));
  const generic = buildPrompt(article(), {});
  assert.ok(generic.includes('客户、项目、组织、现金流、决策或自律'));
  assert.ok(generic.includes('正在创业的独立开发者'), '缺省 businessContext 用通用处境');
  assert.ok(generic.includes('（还没有）'), '没有历史督促时应显式说明');
  assert.equal(/\n\n\n/.test(generic), false, 'prompt 不应出现连续空行');
});

test('buildPrompt v2: recentNags 写进“最近已经说过的”', () => {
  const prompt = buildPrompt(article(), { recentNags: ['别再自我安慰了。', '今天只做一件能拿到反馈的事。'] });
  assert.ok(prompt.includes('1. 别再自我安慰了。'));
  assert.ok(prompt.includes('2. 今天只做一件能拿到反馈的事。'));
});

// ---------------------------------------------------------------------------
// stripFrontmatter / ROUTES
// ---------------------------------------------------------------------------
test('stripFrontmatter: 去掉 YAML frontmatter 与 BOM，正文不含前导空行（回归）', () => {
  const text = '---\nname: maoxuan-vademecum\ndescription: d\n---\n\n# 标题\n\n正文';
  assert.equal(stripFrontmatter(text), '# 标题\n\n正文', '注册进 skill 的正文应从标题开始');
  assert.equal(stripFrontmatter('\uFEFF---\nname: x\n---\n正文'), '正文');
  assert.equal(stripFrontmatter('---\nname: x\n---\n\n\n\n# T\n'), '# T\n', '连续多个前导空行应全部剥掉');
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\n\r\n# T'), '# T', 'CRLF frontmatter');
  assert.equal(stripFrontmatter('# 没有 frontmatter'), '# 没有 frontmatter');
  assert.equal(stripFrontmatter('---\nname: x\n没有结束标记'), '---\nname: x\n没有结束标记');
  assert.equal(stripFrontmatter(''), '');
});

test('ROUTES: 与契约 §3 的六条路由完全一致', () => {
  assert.deepEqual(ROUTES, {
    state: '/api/dsh-maoxuan-pet.state',
    generate: '/api/dsh-maoxuan-pet.generate',
    dismiss: '/api/dsh-maoxuan-pet.dismiss',
    asset: '/api/dsh-maoxuan-pet.asset',
    corpus: '/api/dsh-maoxuan-pet.corpus',
    shell: '/api/dsh-maoxuan-pet.shell',
  });
});

test('friendlyHeadlessError: MISSING_CREDENTIAL 转成可操作的指引', () => {
  const out = friendlyHeadlessError('headless 退出码 1：dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"');
  assert.match(out, /Models/);
  assert.match(out, /profile/);
  assert.equal(friendlyHeadlessError('headless 超时（180s）'), 'headless 超时（180s）', '其他错误原样透传');
});

test('childHeadlessEnv (v0.2.3): 只补 overlay 声明且缺失的 apiKeyEnv 名', () => {
  const DSH_HOME_DIR = '/tmp/maoxuan-no-such-home';
  const overlay = "- id: llm-pi-ai\n  config:\n    providers:\n      wocheng:\n        apiKeyEnv: WOCHENG_API_KEY\n";
  const env = childHeadlessEnv(overlay, {
    HOME: '/tmp/maoxuan-no-such-home',
    DSH_HOME: DSH_HOME_DIR,
    OTHER: '1',
  });
  assert.equal(env.DSH_MAOXUAN_PET_CHILD, '1');
  assert.equal(env.OTHER, '1');
  assert.equal('WOCHENG_API_KEY' in env, false, '无 refs 文件时不注入');
  const withKey = childHeadlessEnv(overlay, {
    HOME: '/tmp/maoxuan-no-such-home',
    DSH_HOME: DSH_HOME_DIR,
    WOCHENG_API_KEY: 'user-set',
  });
  assert.equal(withKey.WOCHENG_API_KEY, 'user-set', '用户显式 env 优先');
});
