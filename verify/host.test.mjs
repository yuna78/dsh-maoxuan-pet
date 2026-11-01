#!/usr/bin/env node
/**
 * Host end-to-end test with a fake Cordis context.
 *
 * `node verify/host.test.mjs`
 *
 * Hard constraints (see verify/README.md):
 *   - no network, no `dsh` subprocess, no model calls, no real timers;
 *   - `headless: false` everywhere, so `runHeadless()` can never be reached and
 *     the fallback path (local excerpt, mode `offline`) is what gets exercised;
 *   - every external resource lives in an OS temp dir created per run and
 *     removed afterwards; the repository is never written to.
 *
 * Why the fixture copies `index.js`: `apply()` resolves `assets/`, `corpus/`
 * and `skill/` from its own `import.meta.url` (that is how the installed package
 * finds its bundled files), so the only way to point those paths at a temp dir
 * without editing the real plugin is to import a byte-identical copy that lives
 * inside the fixture. The copy is verified against the repo file before use, so
 * the test still runs the real Host code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, readdir, unlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 断言用的纯函数/常量取自仓库 index.js；上面已断言夹具里的副本与仓库文件逐字节相同，
// 所以这里检查的仍是同一份 Host 语义（不启动子进程、不联网）。
import {
  isVerbatim,
  TEMPLATES,
  TEMPLATE_LABEL,
  AXES,
  MAX_BUBBLE_CHARS,
  LIMITS,
} from '../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoIndexSource = await readFile(join(root, 'index.js'), 'utf8');

// 1x1 transparent PNG — enough for the asset route's readFile/stat/size checks.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ROUTES = {
  state: '/api/dsh-maoxuan-pet.state',
  generate: '/api/dsh-maoxuan-pet.generate',
  dismiss: '/api/dsh-maoxuan-pet.dismiss',
  asset: '/api/dsh-maoxuan-pet.asset',
  corpus: '/api/dsh-maoxuan-pet.corpus',
  shell: '/api/dsh-maoxuan-pet.shell',
};

/** 桌宠壳的 cookie-less 公开路由（与 index.js 的 SHELL_ROUTES 同步）。 */
const SHELL_ROUTES = {
  state: '/dsh-maoxuan-pet/pet.json',
  asset: '/dsh-maoxuan-pet/asset.png',
  generate: '/dsh-maoxuan-pet/generate',
  dismiss: '/dsh-maoxuan-pet/dismiss',
};

const ARTICLE_FIXTURES = [
  {
    id: 'fan-dui-ben-ben-zhu-yi',
    title: '反对本本主义',
    year: '1930年5月',
    date: '1930-05',
    volume: '第一卷',
    tags: ['调查研究', '实践'],
    file: 'articles/fan-dui-ben-ben-zhu-yi.md',
    sourceUrl: 'https://example.invalid/fan-dui-ben-ben-zhu-yi',
    quote: '没有调查，没有发言权。',
    summary: '当时红军中有人靠本本和上级指示办事，作者主张先做社会调查再下判断，'
      + '把结论建立在实际情况上，而不是建立在文件和想当然上。这个判断方法至今仍适用于产品与客户决策。',
    businessAngle: '把“我觉得用户需要”换成一次可验证的客户访谈，先拿到证据再拍板。',
    verified: true,
  },
  {
    id: 'shi-jian-lun',
    title: '实践论',
    year: '1937年7月',
    date: '1937-07',
    volume: '第一卷',
    tags: ['认识论', '实践'],
    file: 'articles/shi-jian-lun.md',
    sourceUrl: 'https://example.invalid/shi-jian-lun',
    quote: '你要知道梨子的滋味，你就得变革梨子，亲口吃一吃。',
    summary: '文章讨论认识与实践的关系：认识从实践来，又要回到实践中接受检验，'
      + '脱离实践的理论会变成空话。对创业者来说，判断只能在真实客户和真实交付中得到修正。',
    businessAngle: '把本周最重要的一个假设列出来，用一次真实交付去检验它，而不是开会讨论。',
    verified: true,
  },
];

/**
 * 每篇的“全文”。契约 §3 要求 quote/excerpt 必须逐字出现在 corpus/articles/<id>.md，
 * 所以夹具正文必须真的包含 quote，且段落 ≥40 字（extractExcerpt 的入选门槛）。
 */
const ARTICLE_BODIES = {
  'fan-dui-ben-ben-zhu-yi': [
    '# 反对本本主义',
    '',
    '没有调查，没有发言权。这是正文里的一句原文，用来测试逐字校验与节选窗口的提取，长度需要超过四十个字符才行。',
    '',
    '第二段正文也不短，同样超过四十个字符，用于种子轮换测试，再补几个字凑够长度，确保能被选中。',
    '',
    '资料来源：https://example.invalid/fan-dui-ben-ben-zhu-yi',
  ].join('\n'),
  'shi-jian-lun': [
    '# 实践论',
    '',
    '你要知道梨子的滋味，你就得变革梨子，亲口吃一吃。这是正文里的一句原文，用来测试逐字校验，长度需要超过四十个字符才行。',
    '',
    '第二段正文同样超过四十个字符，用于测试节选窗口与种子轮换，再补几个字凑够长度，确保能被选中。',
    '',
    '资料来源：https://example.invalid/shi-jian-lun',
  ].join('\n'),
};

/**
 * Fake Cordis context: records every registration and leaves no live handles.
 * `timeout()` deliberately never fires — the scheduler is asserted structurally
 * (`nextRunAt`, registered delay) instead of by waiting.
 */
function createFakeCtx() {
  const routes = [];
  const webRoutes = [];
  const skills = [];
  const disposers = [];
  const timeouts = [];
  const logs = [];

  const registerRoute = (route) => {
    routes.push(route);
    return () => {};
  };

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
      debug: (message) => logs.push(['debug', message]),
    },
    effect(fn, label) {
      const dispose = fn();
      disposers.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} });
      return () => {};
    },
    inject(_deps, callback) {
      const scope = {
        effect: (fn, label) => ctx.effect(fn, label),
        connection: { fetch: { register: registerRoute } },
        webServer: {
          register(route) {
            webRoutes.push(route);
            return () => {};
          },
        },
        skills: {
          register(definition) {
            skills.push(definition);
            return () => {};
          },
        },
      };
      callback(scope);
      return () => {};
    },
    timeout(fn, ms) {
      timeouts.push({ fn, ms });
      return () => {};
    },
    connection: { fetch: { register: registerRoute } },
  };

  return {
    ctx,
    routes,
    webRoutes,
    skills,
    timeouts,
    logs,
    disposeAll() {
      for (const entry of disposers.reverse()) {
        try { entry.dispose(); } catch { /* 清理不应掩盖真正失败 */ }
      }
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded polling helper: never longer than 2s total (task requirement). */
async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

/** Real `Request` objects: the Host reads `request.url` and `request.text()`. */
function makeRequest(path, { method = 'GET', body, query = '' } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(`http://pet.fixture${path}${query}`, init);
}

async function readJson(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store',
    '契约 §3：所有 JSON 路由必须 no-store');
  return response.json();
}

async function setupFixture(articles = ARTICLE_FIXTURES) {
  // macOS 的 /var 是指向 /private/var 的符号链接；`import()` 会把 URL 解析成
  // 真实路径，所以先 realpath，避免断言里出现 /var 与 /private/var 的假失败。
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'maoxuan-pet-verify-')));
  // Byte-identical copy of the Host; the fixture only adds bundled resources.
  await copyFile(join(root, 'index.js'), join(dir, 'index.js'));
  assert.equal(await readFile(join(dir, 'index.js'), 'utf8'), repoIndexSource,
    '夹具里的 index.js 必须与仓库中的 host 完全一致');

  await mkdir(join(dir, 'corpus'), { recursive: true });
  await writeFile(join(dir, 'corpus', 'index.json'), JSON.stringify({
    version: 1,
    generatedAt: '2026-10-31T00:00:00.000Z',
    edition: 'verify fixture',
    sources: [{ name: 'fixture', url: 'https://example.invalid/index' }],
    articles,
  }, null, 2));

  await mkdir(join(dir, 'corpus', 'articles'), { recursive: true });
  for (const article of articles) {
    if (ARTICLE_BODIES[article.id]) {
      await writeFile(join(dir, 'corpus', article.file), ARTICLE_BODIES[article.id]);
    }
  }

  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'pet-idle.png'), PNG_1X1);

  return dir;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
test('host E2E（假 ctx，无网络 / 无子进程 / 无模型调用）', async (t) => {
  const dir = await setupFixture();
  const statePath = join(dir, 'state', 'pet.json');
  const previousStateEnv = process.env.DSH_MAOXUAN_PET_STATE;
  process.env.DSH_MAOXUAN_PET_STATE = statePath;

  let host;
  let fake;
  let api;
  try {
    host = await import(pathToFileURL(join(dir, 'index.js')).href);
    fake = createFakeCtx();
    api = await host.apply(fake.ctx, {
      enabled: false,          // 不启动定时器：测试里没有任何真实等待与后台生成
      headless: false,         // 关键：永不 spawn headless dsh 子进程
      everySeconds: 600,
      firstDelaySeconds: 1,
      maxBubbles: 2,           // 便于断言 trim() 的截断行为
      quietHours: [3, 4],
      businessContext: '夹具：独立开发者，卖订阅制工具',
    });

    await t.test('apply() 返回 snapshot/runOnce/config 供测试与首次渲染使用', () => {
      assert.equal(typeof api.snapshot, 'function');
      assert.equal(typeof api.runOnce, 'function');
      assert.equal(api.config.headless, false);
      assert.equal(api.config.everySeconds, 600);
      assert.equal(api.snapshot().version, 1);
    });

    await t.test('注册 5 条路由，path/methods 与契约 §3 一致', () => {
      assert.equal(fake.routes.length, 6, `应注册 6 条路由（含桌宠壳开关），实际 ${fake.routes.length}`);
      const byPath = new Map(fake.routes.map((route) => [route.path, route]));
      assert.deepEqual([...byPath.keys()].sort(), Object.values(ROUTES).sort());
      assert.deepEqual(byPath.get(ROUTES.state).methods, ['GET']);
      assert.deepEqual(byPath.get(ROUTES.corpus).methods, ['GET']);
      assert.deepEqual(byPath.get(ROUTES.asset).methods, ['GET']);
      assert.deepEqual(byPath.get(ROUTES.generate).methods, ['POST']);
      assert.deepEqual(byPath.get(ROUTES.dismiss).methods, ['POST']);
      assert.deepEqual(byPath.get(ROUTES.shell).methods, ['GET', 'POST']);
      for (const route of fake.routes) {
        assert.equal(typeof route.fetch, 'function', `${route.path} 缺少 fetch 处理器`);
        // 契约 §6.1：真实 dsh web 里缺 requestBody:'buffered' 会让 GET 构造流式
        // 请求并抛错，Host 最终回 400 且 handler 根本不被调用。
        assert.equal(route.requestBody, 'buffered', `${route.path} 缺 requestBody: 'buffered'`);
      }
    });

    const route = (path) => {
      const found = fake.routes.find((entry) => entry.path === path);
      assert.ok(found, `未注册路由 ${path}`);
      return found;
    };

    await t.test('桌宠壳公开路由：默认注册 4 条、不需要任何 cookie/token', async () => {
      assert.equal(fake.webRoutes.length, 4, `应注册 4 条公开路由，实际 ${fake.webRoutes.length}`);
      const byPath = new Map(fake.webRoutes.map((entry) => [entry.path, entry]));
      assert.deepEqual([...byPath.keys()].sort(), Object.values(SHELL_ROUTES).sort());
      for (const entry of fake.webRoutes) {
        assert.equal(entry.kind, 'exact', `${entry.path} 必须是 exact 路由`);
        assert.equal(typeof entry.handler, 'function', `${entry.path} 缺 handler`);
      }

      // 走一遍 node 风格的 req/res：无 cookie、无 Authorization，必须直接 200
      const nodeFetch = (path, { method = 'GET', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
        const res = {
          status: 0,
          body: Buffer.alloc(0),
          headers: {},
          writeHead(status, hdrs) { this.status = status; Object.assign(this.headers, hdrs || {}); },
          end(chunk) { this.body = Buffer.concat([this.body, Buffer.from(chunk ?? '')]); resolve(this); },
        };
        const req = Readable.from(body ? [Buffer.from(body)] : []);
        req.method = method;
        req.url = path;
        req.headers = headers;
        const entry = byPath.get(path.split('?')[0]);
        assert.ok(entry, `未注册公开路由 ${path}`);
        entry.handler(req, res).catch(reject);
      });

      const stateRes = await nodeFetch(SHELL_ROUTES.state);
      assert.equal(stateRes.status, 200, '公开 state 不鉴权，应直接 200');
      const snapshot = JSON.parse(stateRes.body.toString('utf8'));
      assert.equal(snapshot.version, 1);

      const assetRes = await nodeFetch(SHELL_ROUTES.asset + '?name=idle');
      assert.equal(assetRes.status, 200);
      assert.match(String(assetRes.headers['content-type'] ?? ''), /image\/png/);

      // POST 的跨站防护：缺自定义头 → 403；带齐 → 200
      const forged = await nodeFetch(SHELL_ROUTES.dismiss, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(forged.status, 403, '缺 x-dsh-maoxuan-pet 头的 POST 必须 403');
      const allowed = await nodeFetch(SHELL_ROUTES.dismiss, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-maoxuan-pet': '1' },
        body: '{}',
      });
      assert.equal(allowed.status, 200, '带自定义头的 POST 应放行');
    });

    await t.test('publicRoutes: false 时一条公开路由都不注册（可关闭）', async () => {
      const off = createFakeCtx();
      await host.apply(off.ctx, {
        enabled: false, headless: false, publicRoutes: false,
      });
      assert.equal(off.webRoutes.length, 0);
    });

    await t.test('shell 路由：GET 是状态快照，POST 非法 action 是 400', async () => {
      const status = await route(ROUTES.shell).fetch(makeRequest(ROUTES.shell));
      assert.equal(status.status, 200);
      const body = await readJson(status);
      assert.equal(typeof body.supported, 'boolean');
      assert.equal(typeof body.running, 'boolean');
      assert.equal(body.building, false);

      const bad = await route(ROUTES.shell).fetch(
        makeRequest(ROUTES.shell, { method: 'POST', body: { action: 'nonsense' } }));
      assert.equal(bad.status, 400);
      const badBody = await readJson(bad);
      assert.match(String(badBody.error), /launch|quit/);
    });


    await t.test('state 路由：快照字段齐全（首次调用会等待语料就绪）', async () => {
      const response = await route(ROUTES.state).fetch(makeRequest(ROUTES.state));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const snapshot = await readJson(response);

      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.running, false);
      assert.equal(snapshot.mode, 'offline');
      assert.equal(snapshot.everySeconds, 600);
      assert.ok(Number.isFinite(Date.parse(snapshot.now)), 'now 必须是 ISO 时间');
      assert.equal(snapshot.lastRunAt, null);
      assert.equal(snapshot.nextRunAt, null, 'enabled=false 时不应安排下次运行');
      assert.equal(snapshot.lastError, null);
      assert.equal(snapshot.unread, 0);
      assert.equal(snapshot.current, null);
      assert.deepEqual(snapshot.bubbles, []);
      assert.equal(snapshot.corpus.count, ARTICLE_FIXTURES.length);
      assert.equal(snapshot.corpus.lastTitle, null);
      assert.equal(snapshot.corpus.error, null);
      assert.equal(typeof snapshot.corpus.updatedAt, 'string');

      assert.equal(snapshot.pet.name, '鲸鱼娘·小毛');
      for (const key of ['idle', 'talk', 'blink']) {
        assert.equal(snapshot.pet.sprites[key], `${ROUTES.asset}?name=${key}`,
          `pet.sprites.${key} 必须是契约里的 asset 路由`);
      }
    });

    await t.test('generate 路由：headless:false 时走本地摘录（mode=offline），字段齐全', async () => {
      const response = await route(ROUTES.generate).fetch(makeRequest(ROUTES.generate, { method: 'POST', body: {} }));
      assert.equal(response.status, 200);
      const body = await readJson(response);
      assert.equal(body.ok, true);
      assert.equal(body.running, false);
      const bubble = body.bubble;
      assert.ok(bubble, 'generate 必须返回 bubble');
      // 契约 §3 的 id 形状：b-YYYYMMDDTHHMMSS-xxxx（Host 已改为该格式）。
      assert.match(bubble.id, /^b-\d{8}T\d{6}-[0-9a-f]{4}$/, `bubble.id 格式不符：${bubble.id}`);
      assert.ok(Number.isFinite(Date.parse(bubble.at)));
      assert.equal(bubble.read, false);
      assert.equal(bubble.mode, 'offline', '没有模型调用时必须是离线摘录，不能伪装成 headless');
      assert.ok(ARTICLE_FIXTURES.some((article) => article.id === bubble.articleId));
      assert.equal(bubble.title, '反对本本主义', 'cursor=0 应先挑第一条');
      assert.equal(bubble.year, '1930年5月');
      assert.equal(bubble.sourceUrl, ARTICLE_FIXTURES[0].sourceUrl);

      // --- Bubble v2 ---
      assert.ok(TEMPLATES.includes(bubble.template), `非法 template：${bubble.template}`);
      assert.equal(bubble.template, 'quote', '第 1 条按 quote → excerpt → summary 从金句开始');
      assert.ok(bubble.cite && typeof bubble.cite === 'object', 'v2 必须带 cite 对象');
      assert.equal(bubble.cite.kind, bubble.template, 'cite.kind 必须与 template 一致');
      assert.equal(bubble.cite.label, TEMPLATE_LABEL[bubble.template]);
      assert.equal(bubble.cite.label, '原文');
      assert.ok(bubble.cite.text.length > 0, 'cite.text 不能为空');
      assert.equal(bubble.cite.text, '没有调查，没有发言权。');
      assert.equal(isVerbatim(ARTICLE_BODIES[bubble.articleId], bubble.cite.text), true,
        '金句必须逐字出现在 corpus/articles/<id>.md');
      assert.ok(AXES.includes(bubble.axis), `非法 axis：${bubble.axis}`);
      assert.equal(typeof bubble.pua, 'string', 'pua 必须是字符串（模型复述原文时可为空）');
      assert.ok(bubble.pua.length <= LIMITS.pua, `pua 超过 ${LIMITS.pua} 字：${bubble.pua.length}`);
      assert.equal(typeof bubble.lesson, 'string');
      assert.ok(bubble.lesson.length > 0 && bubble.lesson.length <= LIMITS.lesson,
        `lesson 应为 1..${LIMITS.lesson} 字，实际 ${bubble.lesson.length}`);
      assert.equal(typeof bubble.chars, 'number');
      assert.equal(bubble.chars, bubble.cite.text.length + bubble.pua.length + bubble.lesson.length,
        'chars 必须等于 cite + pua + lesson 的字数');
      assert.ok(bubble.chars <= MAX_BUBBLE_CHARS, `chars 必须 ≤${MAX_BUBBLE_CHARS}，实际 ${bubble.chars}`);
      assert.ok(['sharp', 'calm', 'urgent'].includes(bubble.tone), `非法 tone：${bubble.tone}`);
      // v1 字段必须已经消失（Client 只依赖 v2）
      for (const legacy of ['thought', 'insight', 'nag', 'action', 'quote']) {
        assert.equal(legacy in bubble, false, `v2 bubble 不应再有 v1 字段 ${legacy}`);
      }
    });

    await t.test('generate 后 state：current 非空、unread===1、bubbles 倒序', async () => {
      const snapshot = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(snapshot.unread, 1);
      assert.ok(snapshot.current, 'current 应为最新未读气泡');
      assert.equal(snapshot.current.mode, 'offline');
      assert.equal(snapshot.bubbles.length, 1);
      assert.equal(snapshot.bubbles[0].id, snapshot.current.id);
      assert.equal(snapshot.todayRuns, 1);
      assert.ok(Number.isFinite(Date.parse(snapshot.lastRunAt)));
    });

    let firstBubble;
    let secondBubble;
    await t.test('再次 generate：轮转到下一篇，且新气泡排在最前', async () => {
      const snapshot = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      firstBubble = snapshot.bubbles[0];

      const body = await readJson(await route(ROUTES.generate)
        .fetch(makeRequest(ROUTES.generate, { method: 'POST' })));
      assert.equal(body.ok, true);
      secondBubble = body.bubble;
      assert.notEqual(secondBubble.id, firstBubble.id, 'id 必须唯一');
      assert.notEqual(secondBubble.articleId, firstBubble.articleId, '应轮转到下一篇且排除最近用过的篇目');
      assert.equal(secondBubble.title, '实践论');

      // 两条连续生成必须轮转模板：quote → excerpt（契约 §3 模板轮转）。
      assert.equal(firstBubble.template, 'quote');
      assert.equal(secondBubble.template, 'excerpt', '第 2 条应轮转到节选模板');
      assert.notEqual(secondBubble.template, firstBubble.template);
      assert.equal(secondBubble.cite.kind, 'excerpt');
      assert.equal(secondBubble.cite.label, '节选');
      assert.ok(secondBubble.cite.text.length > 0);
      assert.ok(secondBubble.cite.text.length <= LIMITS.excerpt, `节选超过 ${LIMITS.excerpt} 字`);
      assert.equal(isVerbatim(ARTICLE_BODIES[secondBubble.articleId], secondBubble.cite.text), true,
        '节选必须逐字出现在 corpus/articles/<id>.md');
      assert.notEqual(secondBubble.cite.text, firstBubble.cite.text, '两条的引用内容不应相同');
      assert.ok(secondBubble.chars <= MAX_BUBBLE_CHARS);
      assert.equal(secondBubble.chars,
        secondBubble.cite.text.length + secondBubble.pua.length + secondBubble.lesson.length);

      const after = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(after.bubbles.length, 2);
      assert.equal(after.bubbles[0].id, secondBubble.id, 'bubbles 必须按时间倒序');
      assert.equal(after.unread, 2);
      assert.equal(after.current.id, secondBubble.id);
    });

    await t.test('maxBubbles 生效：历史气泡被截断（配置 2 条）', async () => {
      // 第 3 条会轮到 summary 模板：offline 下它的 cite 目前退化成篇名（已报 lead 的
      // 缺陷 C），所以这里只断言计数，不把“篇名当概括”写成期望。
      await route(ROUTES.generate).fetch(makeRequest(ROUTES.generate, { method: 'POST' }));
      const snapshot = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(snapshot.bubbles.length, 2, 'maxBubbles=2 应只保留 2 条');
      assert.ok(!snapshot.bubbles.some((bubble) => bubble.id === firstBubble.id), '最旧的气泡应被 trim 掉');
    });

    await t.test('dismiss 路由：按 id 标记已读，unread 递减；省略 id 时标记 current', async () => {
      const before = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      const newest = before.bubbles[0];

      const byId = await readJson(await route(ROUTES.dismiss)
        .fetch(makeRequest(ROUTES.dismiss, { method: 'POST', body: { id: newest.id } })));
      assert.equal(byId.ok, true);
      assert.equal(byId.unread, 1, '只应把指定气泡标为已读');

      const afterById = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(afterById.unread, 1);
      assert.equal(afterById.current.id, before.bubbles[1].id, 'current 应前移到下一条未读');

      // 请求体缺失 → 标记 current；非法 JSON 也不能 500。
      const noId = await readJson(await route(ROUTES.dismiss)
        .fetch(makeRequest(ROUTES.dismiss, { method: 'POST', body: 'not-json' })));
      assert.equal(noId.ok, true);
      assert.equal(noId.unread, 0);

      const finalState = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(finalState.current, null, '没有未读时 current 必须为 null');
      assert.equal(finalState.unread, 0);
      assert.ok(finalState.bubbles.every((bubble) => bubble.read === true));
    });

    await t.test('并发两次 generate：同步抢占 in-flight 位，只产出 1 条气泡（另一个 202）', async () => {
      const before = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(before.unread, 0);

      const generate = route(ROUTES.generate);
      const [first, second] = await Promise.all([
        generate.fetch(makeRequest(ROUTES.generate, { method: 'POST' })),
        generate.fetch(makeRequest(ROUTES.generate, { method: 'POST' })),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 202],
        `并发应得到一次 200 + 一次 202（202 = 已在生成中，不排队），实际 ${statuses.join(' / ')}`);

      const accepted = first.status === 200 ? first : second;
      const rejected = first.status === 202 ? first : second;
      const acceptedBody = await readJson(accepted);
      assert.equal(acceptedBody.ok, true);
      assert.ok(acceptedBody.bubble, '200 的响应必须带 bubble');
      assert.match(acceptedBody.bubble.id, /^b-\d{8}T\d{6}-[0-9a-f]{4}$/);

      const rejectedBody = await readJson(rejected);
      assert.equal(rejectedBody.ok, true);
      assert.equal(rejectedBody.running, true, '202 响应应说明正在生成');
      assert.equal(rejectedBody.bubble, null, '202 不得排队重复生成');

      const after = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
      assert.equal(after.unread, 1, '并发两次只应产生一条未读气泡');
      assert.equal(after.running, false, 'running 必须复位');
      assert.equal(after.bubbles.filter((bubble) => bubble.read === false).length, 1);
      assert.equal(after.bubbles[0].id, acceptedBody.bubble.id);
    });

    await t.test('asset 路由：返回 PNG 字节与缓存头，未知 name 回落到 idle', async () => {
      const idle = await route(ROUTES.asset).fetch(makeRequest(ROUTES.asset, { query: '?name=idle' }));
      assert.equal(idle.status, 200);
      assert.equal(idle.headers.get('content-type'), 'image/png');
      assert.match(idle.headers.get('cache-control') ?? '', /public.*max-age=3600/);
      const bytes = Buffer.from(await idle.arrayBuffer());
      assert.deepEqual(bytes, PNG_1X1, '返回的必须是 assets/pet-idle.png 的真实字节');

      const unknown = await route(ROUTES.asset).fetch(makeRequest(ROUTES.asset, { query: '?name=dragon' }));
      assert.equal(unknown.status, 200, '未知 name 回落到 idle 而不是报错');
      assert.deepEqual(Buffer.from(await unknown.arrayBuffer()), PNG_1X1);

      const noQuery = await route(ROUTES.asset).fetch(makeRequest(ROUTES.asset));
      assert.equal(noQuery.status, 200, '不带 name 时按契约回落到 idle');
      assert.deepEqual(Buffer.from(await noQuery.arrayBuffer()), PNG_1X1);
    });

    await t.test('asset 路由：素材缺失时 404 纯文本，绝不 500 / 不伪造内容', async () => {
      await unlink(join(dir, 'assets', 'pet-idle.png'));
      const missing = await route(ROUTES.asset).fetch(makeRequest(ROUTES.asset, { query: '?name=idle' }));
      assert.equal(missing.status, 404);
      assert.equal(missing.status === 500, false);
      assert.match(missing.headers.get('content-type') ?? '', /text\/plain/);
      assert.match(await missing.text(), /缺少素材/);
    });

    await t.test('corpus 路由：只返回篇目元数据，不含全文', async () => {
      const body = await readJson(await route(ROUTES.corpus).fetch(makeRequest(ROUTES.corpus)));
      assert.ok(Array.isArray(body.articles));
      assert.equal(body.articles.length, ARTICLE_FIXTURES.length);
      const byId = new Map(body.articles.map((article) => [article.id, article]));
      for (const fixture of ARTICLE_FIXTURES) {
        const article = byId.get(fixture.id);
        assert.ok(article, `缺少篇目 ${fixture.id}`);
        assert.deepEqual(Object.keys(article).sort(), ['id', 'quote', 'summary', 'tags', 'title', 'year'].sort());
        assert.equal(article.title, fixture.title);
        assert.equal(article.quote, fixture.quote);
        assert.deepEqual(article.tags, fixture.tags);
        assert.ok(!('file' in article), 'corpus 路由不得泄漏全文路径');
        assert.ok(!('content' in article), 'corpus 路由不得返回全文');
      }
    });

    await t.test('状态文件被原子写入：JSON 可解析且无残留 .tmp', async () => {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(saved.version, 1);
      assert.ok(Array.isArray(saved.bubbles) && saved.bubbles.length >= 1);
      assert.equal(typeof saved.cursor, 'number');
      assert.ok(saved.cursor >= 0);
      assert.ok(Number.isFinite(Date.parse(saved.lastRunAt)));
      const entries = await readdir(dirname(statePath));
      assert.deepEqual(entries.sort(), ['pet.json'], `状态目录不应有临时文件，实际：${entries.join(', ')}`);
    });

    await t.test('skill 注册：maoxuan-vademecum 指向内置语料目录与篇目索引', async () => {
      const skill = await waitFor(() => fake.skills[0]);
      assert.equal(skill.name, 'maoxuan-vademecum');
      assert.equal(skill.source, 'bundled');
      assert.deepEqual(skill.resourceBase, { kind: 'directory', path: join(dir, 'corpus') });
      assert.equal(skill.invocation?.modelInvocable, true);
      assert.equal(skill.invocation?.userInvocable, true);
      assert.ok(skill.description.length > 0);
      assert.ok(skill.whenToUse.includes('毛选'));
      for (const article of ARTICLE_FIXTURES) {
        assert.ok(skill.content.includes(article.title), `skill 内容应包含篇目 ${article.title}`);
      }
      assert.ok(skill.content.includes(join(dir, 'corpus')), 'skill 内容应注入运行时语料绝对路径');
    });

    await t.test('dispose：清理定时器与路由不抛错，且可重复调用', () => {
      assert.doesNotThrow(() => fake.disposeAll());
      assert.equal(fake.timeouts.length, 0, 'enabled=false 不应注册任何定时器');
      assert.doesNotThrow(() => fake.disposeAll());
    });

    // --- 场景 B：enabled=true 时只做结构断言，不真的等 1 秒 -----------------
    process.env.DSH_MAOXUAN_PET_STATE = join(dir, 'state', 'pet-enabled.json');
    const fakeB = createFakeCtx();
    try {
      const hostB = await import(pathToFileURL(join(dir, 'index.js')).href);
      await hostB.apply(fakeB.ctx, {
        enabled: true,
        headless: false,
        firstDelaySeconds: 1,
        everySeconds: 600,
      });

      const snapshotB = await waitFor(async () => {
        const response = await fakeB.routes.find((r) => r.path === ROUTES.state)
          .fetch(makeRequest(ROUTES.state));
        const body = await readJson(response);
        return body.nextRunAt ? body : null;
      });

      await t.test('enabled=true：启动后 arm() 安排 nextRunAt，并只注册一个假定时器', () => {
        assert.equal(snapshotB.enabled, true);
        const next = Date.parse(snapshotB.nextRunAt);
        assert.ok(Number.isFinite(next), `nextRunAt 必须是 ISO 时间：${snapshotB.nextRunAt}`);
        assert.ok(next > Date.now() - 5000, 'nextRunAt 不应在过去');
        assert.equal(fakeB.timeouts.length, 1, '只允许一个待触发的定时器（不重复 arm）');
        assert.ok(fakeB.timeouts[0].ms <= 1000 + 50, `首次延迟应约为 firstDelaySeconds，实际 ${fakeB.timeouts[0].ms}ms`);
        assert.equal(fakeB.routes.length, 6);
      });
    } finally {
      fakeB.disposeAll();
    }
  } finally {
    try { fake?.disposeAll(); } catch { /* ignore */ }
    if (previousStateEnv === undefined) delete process.env.DSH_MAOXUAN_PET_STATE;
    else process.env.DSH_MAOXUAN_PET_STATE = previousStateEnv;
    // 删除前确认路径就是本次 mkdtemp 创建的目录，避免误删。
    assert.equal(dirname(dir), await realpath(tmpdir()));
    assert.ok(dir.includes('maoxuan-pet-verify-'));
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, '临时目录应被清理');
  }
});

test('host E2E：语料为空时 generate 稳定返回 500，且 running 不会卡死（回归）', async () => {
  const dir = await setupFixture([]);
  const statePath = join(dir, 'state', 'pet.json');
  const previousStateEnv = process.env.DSH_MAOXUAN_PET_STATE;
  process.env.DSH_MAOXUAN_PET_STATE = statePath;
  const fake = createFakeCtx();
  try {
    // 独立的模块副本（不同 URL），所以语料目录就是这个夹具的空 corpus/。
    const host = await import(`${pathToFileURL(join(dir, 'index.js')).href}?empty-corpus=1`);
    await host.apply(fake.ctx, { enabled: false, headless: false });
    const route = (path) => {
      const found = fake.routes.find((entry) => entry.path === path);
      assert.ok(found, `未注册路由 ${path}`);
      return found;
    };

    const first = await route(ROUTES.generate).fetch(makeRequest(ROUTES.generate, { method: 'POST' }));
    assert.equal(first.status, 500, '没有可用语料、离线模板也无从摘录时应 500');
    const firstBody = await readJson(first);
    assert.equal(firstBody.ok, false);
    assert.equal(firstBody.running, false, '失败响应必须复位 running');
    assert.equal(firstBody.bubble, null);
    assert.match(String(firstBody.error ?? ''), /语料为空/);

    // 若 finally 没有复位 running，第二次调用会被当成“生成中”返回 202。
    const second = await route(ROUTES.generate).fetch(makeRequest(ROUTES.generate, { method: 'POST' }));
    assert.equal(second.status, 500, '第二次调用仍应是真实失败，而不是 202“生成中”');
    const secondBody = await readJson(second);
    assert.equal(secondBody.running, false);

    const snapshot = await readJson(await route(ROUTES.state).fetch(makeRequest(ROUTES.state)));
    assert.equal(snapshot.running, false);
    assert.deepEqual(snapshot.bubbles, []);
    assert.equal(snapshot.unread, 0);
    assert.equal(snapshot.corpus.count, 0);
    assert.ok(snapshot.lastError?.message, '失败原因应写进 lastError 供 UI 展示');
  } finally {
    fake.disposeAll();
    if (previousStateEnv === undefined) delete process.env.DSH_MAOXUAN_PET_STATE;
    else process.env.DSH_MAOXUAN_PET_STATE = previousStateEnv;
    assert.equal(dirname(dir), await realpath(tmpdir()));
    assert.ok(dir.includes('maoxuan-pet-verify-'));
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, '临时目录应被清理');
  }
});
