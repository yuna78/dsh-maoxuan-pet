/**
 * Host half of `dsh-plugin-maoxuan-pet`.
 *
 * Responsibilities:
 *   - keep one durable snapshot of the pet's mood: which essay it last read,
 *     the bubbles it produced, and when it will read again;
 *   - every hour, ask a *dsh headless* conversation to turn one 毛选 essay into
 *     a short "thought + business insight + nag + action" for the user's own
 *     startup, and fall back to a local excerpt template when the model call
 *     fails (clearly labelled `offline`, never faked as generated);
 *   - expose that state to the Web client over same-origin routes;
 *   - register the bundled 毛选 corpus as the `maoxuan-vademecum` skill so the
 *     `maoxuan-pet` agent preset can quote the actual public texts.
 *
 * Only Node builtins are imported: this package must load from a profile's
 * node_modules without resolving any DSH-internal module.
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const name = 'dsh-maoxuan-pet';
// `connection` gives us same-origin HTTP routes; `timer` is what makes
// `ctx.timeout()` available — Cordis refuses the property without the injection
// (this failed a real `dsh web` boot with "cannot get property timer without
// inject"). `skills` is injected optionally further down, so a profile without
// the skill registry still gets the pet.
export const inject = ['connection', 'timer'];

/** Route namespace; the client polls these. */
export const ROUTES = {
  state: '/api/dsh-maoxuan-pet.state',
  generate: '/api/dsh-maoxuan-pet.generate',
  dismiss: '/api/dsh-maoxuan-pet.dismiss',
  asset: '/api/dsh-maoxuan-pet.asset',
  corpus: '/api/dsh-maoxuan-pet.corpus',
  shell: '/api/dsh-maoxuan-pet.shell',
};

/**
 * Public (loopback, cookie-less) routes for the standalone macOS shell.
 *
 * `/api` is auth-gated from DSH 0.2.1-rc.2 on: a bare URLSession gets 401, and
 * the launch token is only obtainable from a CLI-launched host (the desktop app
 * never prints it). The native shell therefore needs its own door. These routes
 * are registered straight on the web server (like static assets) and are
 * deliberately narrow: GETs are read-only public data; POSTs additionally demand
 * a JSON content-type plus `x-dsh-maoxuan-pet: 1` — a cross-site page cannot
 * send that without a CORS preflight, so it is not a CSRF hole. The listener
 * itself only binds loopback, so this is not reachable from the network.
 */
export const SHELL_ROUTES = {
  state: '/dsh-maoxuan-pet/pet.json',
  asset: '/dsh-maoxuan-pet/asset.png',
  generate: '/dsh-maoxuan-pet/generate',
  dismiss: '/dsh-maoxuan-pet/dismiss',
};

/** Sprite name -> file under assets/. */
const SPRITES = {  idle: 'pet-idle.png',
  talk: 'pet-talk.png',
  blink: 'pet-blink.png',
  read: 'pet-read.png',
};

const SKILL_NAME = 'maoxuan-vademecum';
const PET_NAME = '鲸鱼娘·小毛';
const DAY = 86400000;

export class MaoxuanPetError extends Error {}

// ---------------------------------------------------------------------------
// Pure helpers (exported so `verify/` can test them without a Cordis context)
// ---------------------------------------------------------------------------

/** Normalise user configuration; every field has a safe default. */
export function normaliseConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const int = (value, fallback, min, max) => {
    // `maxBubbles:` written empty in YAML arrives as null, and Number(null) is 0
    // — which would clamp history to the minimum instead of using the default.
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const quiet = Array.isArray(raw.quietHours) && raw.quietHours.length === 2
    ? [int(raw.quietHours[0], 2, 0, 23), int(raw.quietHours[1], 8, 0, 23)]
    : [2, 8];
  return {
    enabled: raw.enabled !== false,
    everySeconds: int(raw.everySeconds, 3600, 60, 7 * 24 * 3600),
    firstDelaySeconds: int(raw.firstDelaySeconds, 90, 1, 3600),
    quietHours: quiet,
    maxBubbles: int(raw.maxBubbles, 40, 1, 500),
    dailyLimit: int(raw.dailyLimit, 24, 0, 500),
    headless: raw.headless !== false,
    dshBin: typeof raw.dshBin === 'string' && raw.dshBin.trim() ? raw.dshBin.trim() : 'dsh',
    // The child keeps the dedicated one-shot `headless` profile (its app is the
    // only one that accepts `--json`); the *model* config is bridged from the
    // host profile at spawn time via a `--patch` overlay, so anything the GUI
    // can use — DeepSeek official, a relay, any provider — works with zero
    // per-machine setup. See syncHeadlessOverlay / extractLlmPatchEntries.
    profile: typeof raw.profile === 'string' && raw.profile.trim() ? raw.profile.trim() : 'headless',
    timeoutMs: int(raw.timeoutMs, 180000, 10000, 900000),
    businessContext: typeof raw.businessContext === 'string' ? raw.businessContext.trim() : '',
    modelHint: typeof raw.modelHint === 'string' ? raw.modelHint.trim() : '',
    // Loopback-public routes for the standalone desktop shell (see SHELL_ROUTES).
    // On by default — without them the shell cannot show content next to the
    // desktop app, which is auth-gated and never reveals its launch token.
    publicRoutes: raw.publicRoutes !== false,
  };
}

/** Translate a raw child-process failure into something a user can act on. */
export function friendlyHeadlessError(message) {
  if (/MISSING_CREDENTIAL/i.test(message)) {
    return `${clip(message, 160)}——修复：打开 Web 界面的 Models 页保存一个可用模型的 API Key（插件默认跟随宿主 profile，宿主能用它就能用）；或在插件配置里显式指定 profile / dshBin。`;
  }
  if (/无法启动 headless|ENOENT/.test(message)) {
    return `${clip(message, 160)}——多数是 PATH 里没有 dsh 命令，可在插件配置里把 dshBin 指到 dsh 的绝对路径。`;
  }
  return message;
}

// --- host-profile → headless child: llm config bridge (v0.2.3) ---------------
// The hourly child runs `dsh --profile headless`, whose bundled patch carries no
// llm provider — so on a fresh install it always died with MISSING_CREDENTIAL
// unless the user happened to export a global DEEPSEEK_API_KEY. The host
// process *does* have a working model stack (that is what the GUI renders with):
// its profile patch declares `agent-default-model` and the provider plugins.
// These two files are plain YAML; bridging is a verbatim copy of the llm
// entries into a `--patch` overlay handed to the child at spawn time.

/** The overlay file handed to every headless child (idempotent, human-inspectable). */
export function headlessOverlayPath(env = process.env) {
  return join(resolveDshHome(env), 'storages', 'dsh-maoxuan-pet.headless-overlay.yml');
}

/** Where the host profile's own patch layer lives, or null if unknown. */
export function hostPatchPath(env = process.env) {
  const dir = env.DSH_PROFILE_DIR?.trim();
  if (dir) return join(dir, 'cordis.patch.yml');
  const home = resolveDshHome(env);
  const profile = env.DSH_PROFILE?.trim();
  if (profile) return join(home, 'profiles', profile, 'cordis.patch.yml');
  return null;
}

/**
 * Copy the llm-related top-level entries out of a profile patch, verbatim.
 * Only Node builtins are allowed in this package, so "parsing" is slicing the
 * top-level `- ` blocks by column-0 boundary lines; profile patches are
 * machine-written simple YAML, and the output is applied by dsh itself, exactly
 * like the original layer. Anything not matching is left out untouched.
 */
export function extractLlmPatchEntries(patchText) {
  const lines = String(patchText ?? '').split('\n');
  const starts = [];
  lines.forEach((line, index) => {
    if (/^- /.test(line)) starts.push(index);
  });
  return starts
    .map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join('\n').replace(/\s+$/, ''))
    .filter((block) => /- id: agent-default-model\b/.test(block)
      || /^\s*name:\s+["']?@deepseek-ai\/dsh-llm-pi-ai["']?\s*$/m.test(block)
      || /^\s*name:\s+["']?@deepseek-ai\/dsh-llm-deepseek-api-key["']?\s*$/m.test(block));
}

/**
 * Write the overlay if its content changed; return the path, or '' when the
 * host patch had no llm entries (then an existing overlay is kept — a stale
 * bridge still beats a child with no model config at all).
 */
export async function syncHeadlessOverlay(env = process.env) {
  const target = headlessOverlayPath(env);
  let text = '';
  const source = hostPatchPath(env);
  if (source) {
    try {
      const entries = extractLlmPatchEntries(await readFile(source, 'utf8'));
      if (entries.length) {
        text = [
          '# Auto-generated by dsh-plugin-maoxuan-pet (v0.2.3).',
          '# The host profile\'s llm entries, bridged verbatim so the hourly',
          '# headless child uses the same model stack as the GUI. Safe to delete:',
          '# the plugin rewrites it on every generation attempt.',
          ...entries,
          '',
        ].join('\n');
      }
    } catch { /* unreadable host patch → no bridge this run */ }
  }
  let existing = '';
  try { existing = await readFile(target, 'utf8'); } catch { /* absent */ }
  if (existing === text) return text ? target : '';
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, target);
  return text ? target : '';
}

/**
 * Read the machine-local credential refs file the web Models page writes
 * (`$DSH_HOME/.credentials.yaml`, only the top-level `refs:` block; the file
 * belongs to the user and is remounted by the harness anyway). Returns a map
 * name → value, {} when absent/unreadable — callers treat any error as
 * "no bridge" and fall back to the honest offline excerpt.
 */
export function readCredentialRefs(env = process.env) {
  try {
    const file = join(resolveDshHome(env), '.credentials.yaml');
    const text = readFileSync(file, 'utf8');
    const refs = {};
    let inRefs = false;
    for (const line of text.split('\n')) {
      if (/^refs:/.test(line)) { inRefs = true; continue; }
      if (inRefs && /^[A-Za-z0-9_]+:/.test(line)) break; // next top-level block
      const match = inRefs && /^  ([A-Za-z0-9_]+): (.+)$/.exec(line);
      if (match) refs[match[1]] = match[2].trim();
    }
    return refs;
  } catch {
    return {};
  }
}

/**
 * The child env for one generation: the host env plus every `apiKeyEnv` the
 * bridged overlay names but the child env does not have, sourced from the
 * credential refs (the same store the GUI reads). Injecting only missing names
 * keeps explicit user-provided env values authoritative; anything unknown is
 * simply not injected, so the child fails with the honest MISSING_CREDENTIAL.
 */
export function childHeadlessEnv(overlayText, childEnv = process.env) {
  const env = { ...childEnv, DSH_MAOXUAN_PET_CHILD: '1' };
  const names = new Set(
    (String(overlayText ?? '').match(/^\s*apiKeyEnv:\s*([A-Za-z0-9_]+)\s*$/gm) ?? [])
      .map((line) => /^ apiKeyEnv:/.test(line) ? line.trim().replace(/^apiKeyEnv:\s*/, '') : line.replace(/^\s*apiKeyEnv:\s*/, '').trim())
      .map((name) => name.trim()),
  );
  if (!names.size) return env;
  const refs = readCredentialRefs(childEnv);
  for (const name of names) {
    if (env[name]) continue;
    const value = refs[name];
    if (value) env[name] = value;
  }
  return env;
}

/** Resolve DSH home the same way the harness does. */
export function resolveDshHome(env = process.env) {
  if (env.DSH_HOME && env.DSH_HOME.trim()) return env.DSH_HOME.trim();
  return join(env.HOME || homedir() || process.cwd(), '.dsh');
}

/** Durable snapshot location; overridable for tests and for isolated profiles. */
export function resolveStatePath(env = process.env) {
  const override = env.DSH_MAOXUAN_PET_STATE;
  if (override && override.trim()) return override.trim();
  return join(resolveDshHome(env), 'storages', 'dsh-maoxuan-pet.json');
}

/** Local wall-clock hour, used only for the quiet window. */
export function isQuietAt(date, [start, end]) {
  const hour = date.getHours();
  // [22, 7] wraps midnight; [2, 8] does not. A start equal to end means "never".
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The next moment after `date` at which the quiet window ends. */
export function quietEnd(date, [start, end]) {
  const at = new Date(date.getTime());
  if (start === end) return at;
  const hour = at.getHours();
  const inWindow = start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inWindow) return at;
  at.setMinutes(0, 0, 0);
  if (start < end) at.setHours(end);
  else if (hour >= start) {
    // Wrapped window and we are after the start: the end is tomorrow morning.
    at.setDate(at.getDate() + 1);
    at.setHours(end);
  } else at.setHours(end);
  return at;
}

/** Start of the local calendar day, used for the per-day generation cap. */
export function startOfLocalDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Strip a leading YAML frontmatter block from a SKILL.md body. */
export function stripFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').trimStart();
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return source;
  const rest = source.slice(end + 4);
  // The body may start with the blank line that separated it from the closing
  // `---`; strip the whole run so a registered skill body starts at its heading.
  return rest.replace(/^(?:\r?\n)+/, '');
}

/**
 * Pull the first JSON object out of a model answer.
 * Models like to wrap JSON in ``` fences or add a sentence before it; the
 * caller still validates every field, so a greedy slice is safe here.
 */
export function extractJson(text) {
  const source = String(text ?? '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The three bubble templates the user asked for: quote / excerpt / summary. */
export const TEMPLATES = ['quote', 'excerpt', 'summary'];
export const TEMPLATE_LABEL = { quote: '原文', excerpt: '节选', summary: '小毛概括' };
/** Where a lesson can land: the user asked for axes like 组织 / 项目 / 动作. */
export const AXES = ['客户', '项目', '组织', '现金流', '决策', '自律'];
/**
 * Axis names that used to be valid. `人事` was renamed to `组织` on the user's
 * request; state files written before the rename still carry the old value, so
 * reading one maps it instead of falling back to a default.
 */
export const LEGACY_AXES = { 人事: '组织' };
/** Coerce a stored/generated axis to a current one; null when unknown. */
export const coerceAxis = (value) => (AXES.includes(value) ? value : LEGACY_AXES[value] ?? null);
const AXIS_HINT = {
  客户: '获客、复购、客户分层、真实需求',
  项目: '立项、范围、交付、验收',
  组织: '招人、分工、协作、复盘问责',
  现金流: '回款、成本、定价、活下来的余量',
  决策: '判断依据、假设、验证顺序',
  自律: '注意力、拖延、今天的动作',
};
/** Hard cap the user set: one bubble is at most 200 characters of copy. */
export const MAX_BUBBLE_CHARS = 200;
// The real limit is the 200-character bubble; these per-field ceilings only
// keep a single field from eating the whole budget (the user's own example
// lesson — a hard rule plus how to verify it — runs about 90 characters).
export const LIMITS = { quote: 70, excerpt: 90, summary: 70, pua: 40, lesson: 100 };

const normalizeSpace = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Whether `text` appears verbatim in `body` (whitespace-insensitive). */
export function isVerbatim(body, text) {
  const needle = normalizeSpace(text);
  if (!needle) return false;
  const raw = String(body ?? '');
  if (raw.includes(text)) return true;
  // Archives hard-wrap prose, so compare once with every whitespace removed
  // before declaring a quote unverifiable (that would downgrade the bubble).
  const squeeze = (value) => String(value ?? '').replace(/\s+/g, '');
  return normalizeSpace(raw).includes(needle) || squeeze(raw).includes(squeeze(text));
}

/** Trim to the last sentence/clause boundary at or before `max`; null if too tight. */
export function clipAtBoundary(text, max) {
  const source = normalizeSpace(text);
  if (source.length <= max) return source;
  const window = source.slice(0, max + 1);
  const marks = ['。', '！', '？', '；', '，'];
  let cut = -1;
  for (const mark of marks) {
    const at = window.lastIndexOf(mark);
    if (at > cut) cut = at;
  }
  if (cut >= Math.min(12, Math.floor(max / 2))) return window.slice(0, cut + 1);
  // Nothing safe to cut on: keep it whole and let the caller shrink elsewhere.
  return null;
}

/**
 * Take a verbatim excerpt of whole sentences out of an article body.
 * Seeded so consecutive bubbles with the same essay do not repeat the paragraph.
 */
export function extractExcerpt(body, seed = 0, max = LIMITS.excerpt) {
  // The archive files start with an editorial note (dated in italics, then a
  // `*` block explaining why Mao wrote the piece) before the real body, and end
  // with a 资料来源 block. Both are noise for a quote card: pick only body
  // paragraphs that follow a section heading and read as prose.
  const raw = String(body ?? '').split(/\n##\s*资料来源/)[0];
  const blocks = raw
    .split(/\n{2,}/)
    .map((block) => normalizeSpace(block).replace(/^(?:[*\-•]|\d+[.、])\s+/, ''))
    .filter(Boolean);
  const firstHeading = blocks.findIndex((block) => /^##\s/.test(block));
  const candidates = (firstHeading >= 0 ? blocks.slice(firstHeading + 1) : blocks)
    .filter((block) => !/^[#>*\-（(\d]/.test(block))
    .filter((block) => block.length >= 40)
    .filter((block) => !/^(资料来源|来源：|说明：)/.test(block))
    .filter((block) => /[。！？]/.test(block));
  if (!candidates.length) return null;
  const start = Math.abs(Number(seed) || 0) % candidates.length;
  for (let step = 0; step < candidates.length; step += 1) {
    const paragraph = candidates[(start + step) % candidates.length];
    const sentences = paragraph.match(/[^。！？；]+[。！？；]?/g) || [];
    let window = '';
    for (const sentence of sentences) {
      if ((window + sentence).length > max) break;
      window += sentence;
    }
    const text = window.trim();
    if (text.length >= 30) return text;
  }
  return null;
}

/** Choose a template by bubble count so the three styles rotate. */
export function pickTemplate(index) {
  const n = Math.abs(Math.trunc(Number(index) || 0));
  return TEMPLATES[n % TEMPLATES.length];
}

/** Map an essay's tags onto one of the lesson axes. */
export function deriveAxis(article) {
  const tags = Array.isArray(article?.tags) ? article.tags.join(' ') : '';
  const rules = [
    [/调查|实践|实际|矛盾|本本/, '决策'],
    [/群众|领导|组织|干部|作风|团结/, '组织'],
    [/经济|财政|生产|节约|困难/, '现金流'],
    [/战争|战略|持久|主动|进攻|阶段/, '项目'],
    [/阶级|朋友|敌人|统一|联合/, '客户'],
  ];
  for (const [pattern, axis] of rules) if (pattern.test(tags)) return axis;
  return '决策';
}

/** Validate + normalise one model answer (v2: pua / lesson / axis / gist). */
/** Longest shared run of characters between two strings (used to spot echoing). */
export function longestSharedRun(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return 0;
  let best = 0;
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      let k = 0;
      while (left[i + k] && left[i + k] === right[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * Validate + normalise one model answer (v2: pua / lesson / axis / gist).
 * `pua` is optional — a real model sometimes just parrots the quote, and a
 * parroted nag is worse than no nag, so the caller drops echoes separately.
 */
export function normaliseGenerated(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const pua = clip(payload.pua, LIMITS.pua);
  const lesson = clipAtBoundary(payload.lesson, LIMITS.lesson) ?? clip(payload.lesson, LIMITS.lesson);
  if (!lesson) return null;
  const axis = coerceAxis(payload.axis) ?? '项目';
  const gist = clip(payload.gist, LIMITS.summary);
  const tone = ['sharp', 'calm', 'urgent'].includes(payload.tone) ? payload.tone : 'sharp';
  return { pua, lesson, axis, gist, tone };
}

/** Shrink the lesson (our own words) so cite + pua + lesson fit the 200-char cap. */
export function fitLesson(citeText, pua, lesson, max = MAX_BUBBLE_CHARS) {
  const base = String(citeText ?? '').length + String(pua ?? '').length;
  // No floor on the room: the 200-character cap is the promise, so a long cite
  // must shrink the lesson instead of pushing the bubble over budget.
  const room = Math.max(0, max - base);
  let next = clipAtBoundary(lesson, LIMITS.lesson) ?? clip(lesson, LIMITS.lesson);
  if (next.length > room) {
    const cut = room > 0 ? clipAtBoundary(next, room) : null;
    next = cut ?? (room > 1 ? `${next.slice(0, room - 1)}…` : next.slice(0, room));
  }
  const chars = base + next.length;
  return { lesson: next, chars };
}

const PUA_LINES = [
  '别把“在忙”当进度。',
  '这话你上周就该动手了。',
  '先按它做一遍，再跟我辩。',
  '你缺的不是方法，是这一步没做。',
  '今天别再想了，动手。',
  '把“我觉得”换成“我验证过”。',
];

const pickPuaLine = (seed) => PUA_LINES[Math.abs(Math.trunc(Number(seed) || 0)) % PUA_LINES.length];

/**
 * Deterministic local fallback, honestly labelled `offline`.
 * It never invents a quote: the cite text is the corpus quote, a verbatim
 * excerpt of the bundled essay, or the first sentence of the corpus summary.
 */
export function offlineBubble(article, body = '', template = 'quote', now = new Date()) {
  let kind = TEMPLATES.includes(template) ? template : 'quote';
  let text = null;
  if (kind === 'quote') text = clipAtBoundary(article.quote, LIMITS.quote);
  if (kind === 'excerpt') text = extractExcerpt(body, Math.floor(startOfLocalDay(now) / DAY), LIMITS.excerpt);
  if (kind === 'summary') text = clipAtBoundary((article.summary || '').split(/(?<=[。！？])/)[0], LIMITS.summary);
  if (!text) {
    kind = 'summary';
    // Never fall back to the title: a card whose "概括" is the essay's name
    // tells the user nothing, since the title is already shown beside it.
    text = clipAtBoundary((article.summary || '').split(/(?<=[。！？])/)[0], LIMITS.summary)
      || clipAtBoundary(article.summary, LIMITS.summary)
      || clipAtBoundary((article.businessAngle || '').split(/(?<=[。！？])/)[0], LIMITS.summary)
      || clip(article.summary, LIMITS.summary);
  }
  const pua = pickPuaLine(Math.floor(startOfLocalDay(now) / DAY) + (article.id || '').length);
  const rawLesson = clipAtBoundary(article.businessAngle || '', LIMITS.lesson)
    || clip(article.businessAngle || '', LIMITS.lesson)
    || '把这一篇的判断方法写成一条今天就能执行的规则，并标出它需要什么证据。';
  const { lesson, chars } = fitLesson(text, pua, rawLesson);
  return {
    mode: 'offline',
    template: kind,
    cite: { kind, label: TEMPLATE_LABEL[kind], text },
    axis: deriveAxis(article),
    pua,
    lesson,
    chars,
    tone: 'calm',
  };
}

/** Build the headless prompt (v2: one short PUA, no long analysis). */
export function buildPrompt(article, options = {}) {
  const {
    businessContext = '', recentNags = [], modelHint = '', template = 'quote', excerpt = '',
  } = options;
  const past = recentNags.length ? recentNags.map((line, i) => `${i + 1}. ${line}`).join('\n') : '（还没有）';
  const hint = AXIS_HINT[options.axis] ?? '客户、项目、组织、现金流、决策或自律';
  const summaryMode = template === 'summary';
  return [
    `你是「${PET_NAME}」，一只住在 DSH 面板里的鲸鱼娘，穿红军制服、抱着《毛泽东选集》。`,
    '你说话的对象是一位正在创业的人。你要说的不是分析，是一句能让他今天动手的硬话。',
    '',
    `今天读的篇目：《${article.title}》${article.year ? `（${article.year}）` : ''}`,
    `原文金句（已核对，逐字引用不可改写）：${article.quote}`,
    template === 'excerpt' && excerpt ? `本期给你的节选（逐字，不可改写）：${excerpt}` : '',
    `文章主旨：${article.summary}`,
    '',
    businessContext ? `他的处境：${businessContext}` : '他的处境：正在创业的独立开发者，关心客户、现金流、产品验证与执行。',
    `这次启示要落在：${hint}`,
    modelHint ? `语言风格：${modelHint}` : '',
    '',
    '最近已经说过的（不要重复意思）：',
    past,
    '',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：',
    '{',
    `  "pua": "你对他说的一句话，第一人称，≤${LIMITS.pua}字，直接、有压力、不羞辱；必须是你的话，不得重复或改写原文；宁短；不需要就给空字符串",`,
    `  "lesson": "启示：一条能落地的硬规则 + 怎么验证，≤${LIMITS.lesson}字",`,
    `  "axis": "客户 或 项目 或 组织 或 现金流 或 决策 或 自律",`,
    summaryMode ? `  "gist": "用你自己的话概括这篇文章，≤${LIMITS.summary}字，不要加引号",` : '',
    '  "tone": "sharp 或 calm 或 urgent"',
    '}',
    '',
    '硬性要求：',
    `- 引文 + 你写的话合计不超过 ${MAX_BUBBLE_CHARS} 字，宁短不长。`,
    '- 不要改写、不要编造毛选原文；JSON 里不要出现你没被告知的引文。',
    '- 「pua」里不要复述原文（引文已经单独展示），一句话点到他的具体动作即可。',
    '- 不给违法、欺诈、压榨、伤害他人的建议；不把客户、员工或竞争者称为敌人。',
    '- JSON 字符串内不要出现真实换行，全部字段用中文。',
  ].filter((line) => line !== '').join('\n');
}

/**
 * Migrate a v1 bubble (thought/insight/nag/action) to the v2 shape so an
 * existing state file keeps working after the redesign.
 */
export function migrateBubble(old) {
  if (!old || typeof old !== 'object') return old;
  if (old.cite) {
    // Already v2: the only repair left is the `人事` → `组织` rename.
    const axis = coerceAxis(old.axis) ?? '项目';
    return axis === old.axis ? old : { ...old, axis };
  }
  const kind = old.quote ? 'quote' : 'summary';
  const text = clip(old.quote || old.thought || '', kind === 'quote' ? LIMITS.quote : LIMITS.summary);
  const pua = clip(old.nag || '', LIMITS.pua);
  const rawLesson = clip(old.insight || old.action || '', LIMITS.lesson);
  const { lesson, chars } = fitLesson(text, pua, rawLesson);
  return {
    id: old.id,
    at: old.at,
    read: !!old.read,
    mode: old.mode === 'headless' ? 'headless' : 'offline',
    template: kind,
    articleId: old.articleId,
    title: old.title,
    year: old.year || '',
    sourceUrl: old.sourceUrl || '',
    cite: { kind, label: TEMPLATE_LABEL[kind], text },
    axis: coerceAxis(old.axis) ?? '项目',
    pua,
    lesson,
    chars,
    tone: old.tone || 'calm',
  };
}

/** Pick the next verified essay, round-robin, skipping the ones just used. */
export function pickArticle(articles, cursor, recentIds = []) {
  const usable = (Array.isArray(articles) ? articles : []).filter((a) => a && a.id && a.verified !== false && a.quote);
  if (!usable.length) return null;
  for (let step = 0; step < usable.length; step += 1) {
    const index = ((Number(cursor) || 0) + step) % usable.length;
    if (!recentIds.includes(usable[index].id)) {
      return { article: usable[index], index, total: usable.length };
    }
  }
  const index = (Number(cursor) || 0) % usable.length;
  return { article: usable[index], index, total: usable.length };
}

/** Validate the corpus index enough to fail loudly at startup, not mid-hour. */
export function validateCorpus(index) {
  const errors = [];
  if (!index || typeof index !== 'object') return ['index.json 不是对象'];
  if (index.version !== 1) errors.push(`version 期望 1，实际 ${String(index.version)}`);
  if (!Array.isArray(index.articles)) return [...errors, 'articles 不是数组'];
  const seen = new Set();
  for (const [i, article] of index.articles.entries()) {
    const at = `articles[${i}]`;
    if (!article || typeof article !== 'object') { errors.push(`${at} 不是对象`); continue; }
    if (!article.id || typeof article.id !== 'string') errors.push(`${at}.id 缺失`);
    else if (seen.has(article.id)) errors.push(`${at}.id 重复：${article.id}`);
    else seen.add(article.id);
    if (!article.title) errors.push(`${at}.title 缺失`);
    if (article.verified === true && !article.quote) errors.push(`${at} verified=true 但没有 quote`);
  }
  return errors;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const text = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

async function readBody(request) {
  try {
    const raw = await request.text();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = normaliseConfig(config);
  const here = dirname(fileURLToPath(import.meta.url));
  const assetsDir = join(here, 'assets');
  const corpusDir = join(here, 'corpus');
  const corpusIndexPath = join(corpusDir, 'index.json');
  const skillPath = join(here, 'skill', SKILL_NAME, 'SKILL.md');
  const statePath = resolveStatePath();

  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level](`[maoxuan-pet] ${message}`);
    } catch { /* logging must never break the pet */ }
  };

  // --- durable state -------------------------------------------------------
  const state = {
    version: 1,
    cursor: 0,
    templateCursor: 0,
    bubbles: [],
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
  };
  let loaded = false;
  let saveChain = Promise.resolve();
  let running = false;      // in-memory only: a restarted host is not "running"
  let pendingTimer = null;  // disposer for the single armed timer
  let corpus = { articles: [], generatedAt: null, sources: [], edition: '' };
  let corpusError = null;

  const snapshot = () => {
    const now = new Date();
    const unread = state.bubbles.filter((b) => !b.read);
    const todayRuns = state.bubbles.filter((b) => {
      const at = Date.parse(b.at);
      return Number.isFinite(at) && at >= startOfLocalDay(now);
    }).length;
    return {
      version: 1,
      enabled: cfg.enabled,
      running,
      mode: cfg.headless ? 'headless' : 'offline',
      everySeconds: cfg.everySeconds,
      now: now.toISOString(),
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      lastError: state.lastError,
      unread: unread.length,
      todayRuns,
      dailyLimit: cfg.dailyLimit,
      current: unread.length ? unread[0] : null,
      bubbles: state.bubbles,
      corpus: {
        count: corpus.articles.length,
        lastTitle: state.bubbles[0]?.title ?? null,
        updatedAt: corpus.generatedAt,
        error: corpusError,
      },
      pet: {
        name: PET_NAME,
        sprites: Object.fromEntries(Object.keys(SPRITES).map((key) => [key, `${ROUTES.asset}?name=${key}`])),
      },
    };
  };

  const trim = () => {
    state.bubbles.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (state.bubbles.length > cfg.maxBubbles) state.bubbles.length = cfg.maxBubbles;
  };

  const persist = () => {
    saveChain = saveChain.then(async () => {
      await ready;
      try {
        const payload = JSON.stringify({
          version: 1,
          cursor: state.cursor,
          templateCursor: state.templateCursor,
          bubbles: state.bubbles,
          lastRunAt: state.lastRunAt,
          nextRunAt: state.nextRunAt,
          lastError: state.lastError,
        });
        const dir = dirname(statePath);
        const tmp = `${statePath}.tmp`;
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, payload, 'utf8');
        await rename(tmp, statePath);
      } catch (error) {
        log('warn', `状态写入失败：${error?.message ?? error}`);
      }
    }).catch(() => { /* keep the chain alive */ });
    return saveChain;
  };

  const loadState = async () => {
    try {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      state.cursor = Number.isFinite(Number(saved?.cursor)) ? Number(saved.cursor) : 0;
      // A file written before the cursor existed starts the rotation after the
      // bubbles it already holds, so the first new card is not another 金句.
      state.templateCursor = Number.isFinite(Number(saved?.templateCursor))
        ? Number(saved.templateCursor)
        : (Array.isArray(saved?.bubbles) ? saved.bubbles.length % TEMPLATES.length : 0);
      state.lastRunAt = typeof saved?.lastRunAt === 'string' ? saved.lastRunAt : null;
      state.nextRunAt = typeof saved?.nextRunAt === 'string' ? saved.nextRunAt : null;
      state.lastError = saved?.lastError && typeof saved.lastError === 'object' ? saved.lastError : null;
      // A state file written before the v2 redesign still holds v1 bubbles;
      // migrate them instead of dropping the user's history.
      state.bubbles = Array.isArray(saved?.bubbles)
        ? saved.bubbles
          .filter((b) => b && typeof b === 'object' && typeof b.id === 'string' && typeof b.at === 'string')
          .map((b) => migrateBubble(b))
          .filter((b) => b && b.cite && typeof b.cite.text === 'string')
        : [];
      trim();
    } catch { /* first run: an absent or unreadable file opens empty */ }
  };

  const loadCorpus = async () => {
    try {
      const index = JSON.parse(await readFile(corpusIndexPath, 'utf8'));
      const errors = validateCorpus(index);
      if (errors.length) throw new MaoxuanPetError(errors.slice(0, 3).join('；'));
      corpus = {
        articles: index.articles,
        generatedAt: typeof index.generatedAt === 'string' ? index.generatedAt : null,
        sources: Array.isArray(index.sources) ? index.sources : [],
        edition: typeof index.edition === 'string' ? index.edition : '',
      };
      corpusError = null;
    } catch (error) {
      corpus = { articles: [], generatedAt: null, sources: [], edition: '' };
      corpusError = String(error?.message ?? error).slice(0, 300);
      log('warn', `语料加载失败：${corpusError}`);
    }
  };

  const ready = Promise.all([loadState(), loadCorpus()]).then(() => { loaded = true; }).catch((error) => {
    loaded = true;
    log('warn', `初始化失败：${error?.message ?? error}`);
  });

  // --- headless generation -------------------------------------------------
  let child = null;

  const stopChild = () => {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const captured = child;
    setTimeout(() => { try { captured.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref?.();
    child = null;
  };

  /** Run one headless dsh conversation and return the final text, or throw. */
  const runHeadless = (prompt) => new Promise(async (resolvePromise, reject) => {
    // Bridge the host profile's llm config into the one-shot child (idempotent;
    // '' when nothing to bridge — see syncHeadlessOverlay). Must not kill the
    // generation if it fails for any reason: worst case the child errors with
    // the old MISSING_CREDENTIAL and the usual offline fallback kicks in.
    await syncHeadlessOverlay().catch(() => '');
    let overlayText = '';
    try {
      overlayText = await readFile(headlessOverlayPath(), 'utf8');
    } catch { /* no overlay available this run */ }
    const args = ['--profile', cfg.profile];
    if (overlayText.trim()) args.push('--patch', headlessOverlayPath());
    args.push('--json', prompt);
    let proc;
    try {
      proc = spawn(cfg.dshBin, args, {
        cwd: homedir(),
        env: childHeadlessEnv(overlayText),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new MaoxuanPetError(`无法启动 headless：${error?.message ?? error}`));
      return;
    }
    child = proc;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (child === proc) child = null;
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      finish(new MaoxuanPetError(`headless 超时（${Math.round(cfg.timeoutMs / 1000)}s）`));
    }, cfg.timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (error) => finish(new MaoxuanPetError(`headless 启动失败：${error?.message ?? error}`)));
    proc.on('close', (code) => {
      const finalText = lastFinalText(stdout);
      if (code === 0 && finalText) { finish(null, finalText); return; }
      const detail = clip(stderr || stdout || '无输出', 300);
      finish(new MaoxuanPetError(`headless 退出码 ${code}：${detail}`));
    });
  });

  /** Parse the `--json` NDJSON stream and keep the terminal `final` text. */
  function lastFinalText(stream) {
    let output = '';
    for (const line of String(stream ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event?.type === 'final' && typeof event.text === 'string' && event.text.trim()) output = event.text;
        else if (event?.type === 'text' && typeof event.text === 'string' && event.text.trim()) output = event.text;
      } catch { /* ignore malformed lines */ }
    }
    return output;
  }

  // Id shape documented in the contract: `b-YYYYMMDDTHHMMSS-xxxx`.
  const makeBubbleId = (at) => {
    const iso = at.toISOString();            // 2026-11-01T03:32:31.900Z
    const compact = iso.slice(0, 19).replace(/-/g, '').replace(/:/g, '');
    return `b-${compact}-${Math.random().toString(16).slice(2, 6)}`;
  };

  /** One generation attempt: model answer first, local excerpt template as fallback. */
  /** Read one essay's full text, cached per article id (33 files, ~1 MB total). */
  const articleBodies = new Map();
  const readArticleBody = async (article) => {
    if (!article?.file) return '';
    if (articleBodies.has(article.id)) return articleBodies.get(article.id);
    try {
      const body = await readFile(join(corpusDir, article.file), 'utf8');
      articleBodies.set(article.id, body);
      return body;
    } catch {
      articleBodies.set(article.id, '');
      return '';
    }
  };

  const runOnce = async (reason = 'schedule') => {
    // Claim the in-flight slot *synchronously*: two manual POSTs (a double click,
    // or a click racing the hourly tick) would otherwise both pass this check
    // while the first is still awaiting the corpus load.
    if (running) return { ok: true, running: true, bubble: null };
    running = true;
    try {
      await ready;
      if (!corpus.articles.length) {
        const message = corpusError || '语料为空：corpus/index.json 未就绪';
        state.lastError = { at: new Date().toISOString(), message: clip(message, 300) };
        await persist();
        return { ok: false, running: false, bubble: null, error: message };
      }
      const now = new Date();
      const recentIds = state.bubbles.slice(0, 3).map((b) => b.articleId).filter(Boolean);
      const picked = pickArticle(corpus.articles, state.cursor, recentIds);
      const article = picked.article;
      const body = await readArticleBody(article);
      // Rotate 金句 → 节选 → 概括, and try not to repeat the previous axis.
      // A persisted cursor, not `bubbles.length`: once `trim()` caps the list
      // the length stops moving and the template rotation would freeze.
      const template = pickTemplate(state.templateCursor);
      state.templateCursor = (state.templateCursor + 1) % TEMPLATES.length;
      const previousAxis = state.bubbles[0]?.axis;
      const axis = AXES.find((candidate) => candidate !== previousAxis) ?? '决策';
      let citeText = null;
      let citeKind = template;
      if (template === 'excerpt') {
        const excerpt = extractExcerpt(body, state.bubbles.length + Math.floor(startOfLocalDay(now) / DAY), LIMITS.excerpt);
        if (excerpt && isVerbatim(body, excerpt)) citeText = excerpt;
        else citeKind = 'quote';
      }
      if (citeKind === 'quote') {
        citeText = clipAtBoundary(article.quote, LIMITS.quote) ?? clip(article.quote, LIMITS.quote);
        if (!citeText || !isVerbatim(body, citeText)) {
          citeKind = 'summary';
          citeText = clipAtBoundary((article.summary || '').split(/(?<=[。！？])/)[0], LIMITS.summary)
            || clipAtBoundary(article.summary, LIMITS.summary);
        }
      }
      if (!citeText) {
        citeKind = 'summary';
        citeText = clip(article.summary, LIMITS.summary) || clip(article.businessAngle, LIMITS.summary);
      }

      let produced = null;
      let failure = null;

      if (cfg.headless) {
        const prompt = buildPrompt(article, {
          businessContext: cfg.businessContext,
          recentNags: state.bubbles.slice(0, 6).map((b) => b.pua || b.nag).filter(Boolean),
          modelHint: cfg.modelHint,
          template: citeKind,
          excerpt: citeKind === 'excerpt' ? citeText : '',
          axis,
        });
        try {
          const answer = await runHeadless(prompt);
          const generated = normaliseGenerated(extractJson(answer));
          if (generated) produced = { mode: 'headless', ...generated };
          else failure = `模型输出无法解析为约定 JSON（${clip(answer, 120)}）`;
        } catch (error) {
          failure = friendlyHeadlessError(String(error?.message ?? error));
        }
      }

      if (!produced) {
        // Honest fallback: the essay's own words plus a canned nag, labelled offline.
        produced = offlineBubble(article, body, citeKind, now);
        if (failure) state.lastError = { at: now.toISOString(), message: clip(failure, 300) };
        log('warn', `降级为本地摘录：${failure ?? 'headless 已关闭'}`);
      } else if (state.lastError) {
        state.lastError = null;
      }

      // The produced bubble may carry its own verified cite text (the offline
      // path does), and summary mode may reuse the model's own gist.
      if (produced.cite?.text) {
        citeText = produced.cite.text;
        if (TEMPLATES.includes(produced.cite.kind)) citeKind = produced.cite.kind;
      } else if (citeKind === 'summary' && produced.gist) {
        citeText = produced.gist;
      }
      // A nag that repeats the quote is noise: the bubble would say it twice.
      let pua = produced.pua;
      if (pua && longestSharedRun(pua, citeText) >= 8) {
        log('warn', '小毛的话复述了原文，已弃用本条 pua');
        pua = '';
      }
      const fitted = fitLesson(citeText, pua, produced.lesson);
      const bubble = {
        id: makeBubbleId(now),
        at: now.toISOString(),
        read: false,
        mode: produced.mode,
        template: citeKind,
        articleId: article.id,
        title: article.title,
        year: article.year || '',
        sourceUrl: article.sourceUrl || '',
        cite: { kind: citeKind, label: TEMPLATE_LABEL[citeKind], text: citeText },
        axis: produced.axis,
        pua,
        lesson: fitted.lesson,
        chars: fitted.chars,
        tone: produced.tone,
      };
      state.bubbles = [bubble, ...state.bubbles];
      state.cursor = (picked.index + 1) % picked.total;
      state.lastRunAt = bubble.at;
      trim();
      await persist();
      log('info', `已生成毛选督促（${reason} · ${bubble.mode} · ${bubble.template} · ${bubble.title} · ${bubble.chars}字）`);
      return { ok: true, running: false, bubble };
    } catch (error) {
      // Never leave `running` stuck: a stuck flag would freeze both the timer
      // and the manual button until the host restarts.
      state.lastError = { at: new Date().toISOString(), message: clip(error?.message ?? error, 300) };
      await persist().catch(() => {});
      return { ok: false, running: false, bubble: null, error: String(error?.message ?? error) };
    } finally {
      running = false;
    }
  };

  // --- scheduler -----------------------------------------------------------
  const arm = () => {
    clearPending();
    if (!cfg.enabled) { state.nextRunAt = null; return; }
    const now = Date.now();
    let target = state.nextRunAt ? Date.parse(state.nextRunAt) : NaN;
    if (!Number.isFinite(target)) {
      target = now + cfg.firstDelaySeconds * 1000;
    } else if (target <= now) {
      // An overdue slot (host was down) runs soon, not immediately at boot:
      // boot is the worst moment to spend a model call.
      target = now + Math.min(cfg.firstDelaySeconds, 20) * 1000;
    }
    state.nextRunAt = new Date(target).toISOString();
    pendingTimer = later(() => { void tick(); }, Math.max(0, target - Date.now()));
  };

  const later = (fn, ms) => {
    if (typeof ctx.timeout === 'function') return ctx.timeout(fn, ms);
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  };

  const clearPending = () => {
    if (typeof pendingTimer === 'function') {
      try { pendingTimer(); } catch { /* already disposed */ }
    }
    pendingTimer = null;
  };

  const tick = async () => {
    pendingTimer = null;
    const now = new Date();
    if (isQuietAt(now, cfg.quietHours)) {
      const resume = quietEnd(now, cfg.quietHours);
      state.nextRunAt = resume.toISOString();
      await persist();
      arm();
      return;
    }
    const runsToday = state.bubbles.filter((b) => {
      const at = Date.parse(b.at);
      return Number.isFinite(at) && at >= startOfLocalDay(now);
    }).length;
    if (cfg.dailyLimit > 0 && runsToday >= cfg.dailyLimit) {
      // Cap the daily spend; still move the target so the UI has a next time.
      state.nextRunAt = new Date(Math.max(now.getTime() + 60000, startOfLocalDay(now) + DAY)).toISOString();
      await persist();
      arm();
      return;
    }
    await runOnce('schedule');
    state.nextRunAt = new Date(Date.now() + cfg.everySeconds * 1000).toISOString();
    await persist();
    arm();
  };

  ctx.effect(() => () => { clearPending(); stopChild(); }, 'maoxuan-pet.timer');

  // --- skills: expose the bundled corpus to the agent preset ---------------
  ctx.inject?.(['skills'], (scope) => {
    const install = async () => {
      let body = '';
      try {
        body = stripFrontmatter(await readFile(skillPath, 'utf8'));
      } catch {
        body = '';
      }
      const index = corpus.articles
        .map((a) => `- ${a.id}：${a.title}${a.year ? `（${a.year}）` : ''}`)
        .join('\n');
      const content = [
        body || '# 毛选创业 vademecum\n\n按问题检索内置毛选公开语料，引用时逐字、给出篇名与年份。',
        '',
        '## 运行时信息（由插件注入）',
        '',
        `- 语料根目录：${corpusDir}`,
        `- 索引文件：${corpusIndexPath}`,
        `- 抓取时间：${corpus.generatedAt || '未知'}`,
        `- 条目数：${corpus.articles.length}`,
        '',
        '## 篇目索引',
        '',
        index || '（语料尚未就绪：先运行 npm run corpus）',
        '',
        '## 使用规则',
        '',
        '1. 先读索引，选出与用户问题最相关的一到两篇，再用 read 工具打开语料根目录下的对应文件。',
        '2. 引号里的原文必须逐字来自文件，标注篇名与写作时间；核不到就说明未核到，不要凭记忆加引号。',
        '3. 先讲当时面对的问题与论证，再落到用户今天的处境；不要把历史类比写成经营必胜的保证。',
        '4. 不把客户、员工、合作方或竞争者称为敌人；不给违法、欺诈、压榨或伤害他人的建议。',
      ].join('\n');
      const dispose = scope.skills.register({
        name: SKILL_NAME,
        description: '内置《毛泽东选集》公开语料的检索与引用规则：先索引后原文，逐字引用，再落到创业判断。',
        whenToUse: '用户问“根据毛选我应该怎么做”或需要毛选原文支撑的经营判断时',
        content,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: corpusDir },
        invocation: { modelInvocable: true, userInvocable: true },
      });
      scope.effect(() => () => { try { dispose?.(); } catch { /* already gone */ } }, 'maoxuan-pet.skill');
    };
    void ready.then(install).catch((error) => log('warn', `skill 注册失败：${error?.message ?? error}`));
  });

  // --- desktop shell (macOS) supervisor -------------------------------------
  // 独立桌宠壳是个单独的 Swift 进程；界面里的开关只负责 spawn / SIGTERM。
  // 运行状态读壳自己写的 pidfile，所以用 启动小毛.command 手动起的壳也认得出，
  // 不会出现「按钮说她没出来、其实她就在屏幕上」。
  const shellBin = join(here, 'desktop', 'build', 'maoxuan-pet');
  const shellScript = join(here, 'desktop', 'build.sh');
  const shellPidPath = join(resolveDshHome(), 'storages', 'dsh-maoxuan-pet.shell.pid');
  let shellChild = null;
  let shellBusy = false;
  let shellError = null;
  const shellPlatform = process.platform === 'darwin';

  const shellPid = () => {
    try {
      const pid = Number(readFileSync(shellPidPath, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 1) return null;
      process.kill(pid, 0);
      // pid 会被系统复用：编号活着 ≠ 还是小毛。校验进程名，防止徽章状态失真。
      if (shellPlatform) {
        const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
        if (!comm.trim().endsWith('maoxuan-pet')) return null;
      }
      return pid;
    } catch { return null; }
  };

  const shellStatus = () => {
    const pid = shellPid();
    return {
      supported: shellPlatform,
      running: Boolean(pid),
      pid: pid ?? null,
      building: shellBusy,
      error: shellError,
    };
  };

  /** 首次启动：产物不存在就先编（swiftc 几秒钟），编完再起。 */
  const buildShell = () => new Promise((resolve, reject) => {
    const child = spawn('bash', [shellScript], { cwd: here, stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error('编译超时（120s）'));
    }, 120000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(shellBin)) resolve();
      else reject(new Error(`编译失败（exit ${code}）——终端里跑一次 npm run pet:build 看报错`));
    });
  });

  const launchShell = async (origin) => {
    if (!shellPlatform) return { ok: false, supported: false, error: '独立桌宠壳目前只支持 macOS' };
    const pid = shellPid();
    if (pid) return { ok: true, ...shellStatus() };
    if (shellBusy) return { ok: false, ...shellStatus(), error: '正在编译桌宠壳，等几秒' };
    shellError = null;
    try {
      if (!existsSync(shellBin)) {
        shellBusy = true;
        await buildShell();
      }
      const args = ['--public'];
      // 只接受 loopback origin：这个值来自浏览器 location.origin，别让它带去别处
      if (typeof origin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(origin)) {
        origin = origin.replace('localhost', '127.0.0.1').replace('[::1]', '127.0.0.1');
        args.push(`--origin=${origin}`);
      }
      const child = spawn(shellBin, args, { detached: true, stdio: 'ignore' });
      child.unref();
      shellChild = child;
      return { ok: true, ...shellStatus() };
    } catch (error) {
      shellError = String(error?.message || error);
      return { ok: false, ...shellStatus(), error: shellError };
    } finally {
      shellBusy = false;
    }
  };

  const quitShell = () => {
    const pid = shellPid();
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    if (shellChild) {
      try { shellChild.kill(); } catch { /* already gone */ }
      shellChild = null;
    }
    shellError = null;
    return { ok: true, ...shellStatus() };
  };

  // --- transport -----------------------------------------------------------
  // The same five handlers serve both doors: the authenticated `/api` routes the
  // Web client uses, and the loopback-public routes the native shell uses.
  const handlers = {
    state: async () => { await ready; return json(snapshot()); },
    corpus: async () => {
      await ready;
      return json({
        articles: corpus.articles.map((a) => ({
          id: a.id, title: a.title, year: a.year, tags: a.tags, quote: a.quote, summary: a.summary,
        })),
      });
    },
    generate: async () => {
      await ready;
      if (running) return json({ ok: true, running: true, bubble: null }, 202);
      const result = await runOnce('manual');
      if (!result.ok) return json(result, 500);
      return json(result, 200);
    },
    dismiss: async (request) => {
      await ready;
      const body = await readBody(request);
      const target = typeof body.id === 'string' && body.id
        ? state.bubbles.find((b) => b.id === body.id)
        : state.bubbles.find((b) => !b.read);
      if (target && !target.read) {
        target.read = true;
        await persist();
      }
      return json({ ok: true, unread: state.bubbles.filter((b) => !b.read).length });
    },
    shell: async (request) => {
      if (request.method !== 'POST') return json(shellStatus());
      const body = await readBody(request);
      const action = String(body.action || '');
      if (action === 'launch') return json(await launchShell(body.origin));
      if (action === 'quit') return json(quitShell());
      return json({ ok: false, error: 'action 必须是 launch 或 quit' }, 400);
    },
    asset: async (request) => {
      let sprite = 'idle';
      try { sprite = new URL(request.url).searchParams.get('name') || 'idle'; } catch { sprite = 'idle'; }
      const file = SPRITES[sprite] || SPRITES.idle;
      try {
        const [bytes, info] = await Promise.all([readFile(join(assetsDir, file)), stat(join(assetsDir, file))]);
        if (!info.size) throw new MaoxuanPetError('空文件');
        return new Response(bytes, {
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
        });
      } catch {
        return text(`缺少素材：assets/${file}`, 404);
      }
    },
  };

  ctx.inject?.(['connection'], (scope) => {
    const routes = [
      // Required: without an explicit body mode the bridge builds a GET request
      // with a stream body and Node throws, which the Host surfaces as 400.
      { path: ROUTES.state, methods: ['GET'], requestBody: 'buffered', fetch: () => handlers.state() },
      { path: ROUTES.corpus, methods: ['GET'], requestBody: 'buffered', fetch: () => handlers.corpus() },
      { path: ROUTES.generate, methods: ['POST'], requestBody: 'buffered', fetch: () => handlers.generate() },
      { path: ROUTES.dismiss, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handlers.dismiss(request) },
      { path: ROUTES.asset, methods: ['GET'], requestBody: 'buffered', fetch: (request) => handlers.asset(request) },
      { path: ROUTES.shell, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: (request) => handlers.shell(request) },
    ];
    const disposers = routes.map((route) => scope.connection.fetch.register(route));
    scope.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose?.(); } catch { /* already gone */ }
      }
    }, 'maoxuan-pet.routes');
  });

  // --- cookie-less transport for the standalone macOS shell -----------------
  if (cfg.publicRoutes) {
    ctx.inject?.(['webServer'], (webCtx) => {
      // 只认真正的 webServer 服务：没有它（测试里的假 ctx、或非 web 宿主）就安静跳过，
      // 可选增强绝不该把插件主体挂掉。
      const server = webCtx?.webServer;
      if (typeof server?.register !== 'function') {
        log('debug', '公开路由不可用（宿主无 webServer），桌宠壳请改用 --token 走 /api');
        return;
      }
      const register = (path, methods, handler) => {
        const dispose = server.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (!methods.includes(req.method)) {
              res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('method not allowed');
              return;
            }
            if (req.method === 'POST') {
              const type = String(req.headers['content-type'] || '');
              if (!type.includes('application/json') || req.headers['x-dsh-maoxuan-pet'] !== '1') {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('forbidden');
                return;
              }
            }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
              const request = new Request(`http://127.0.0.1${req.url || path}`, {
                method: req.method,
                headers: req.headers,
                body: body || undefined,
              });
              const response = await handler(request);
              res.writeHead(response.status, Object.fromEntries(response.headers));
              res.end(Buffer.from(await response.arrayBuffer()));
            } catch (error) {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
              res.end(String(error?.message || error));
            }
          },
        });
        return dispose;
      };
      const disposers = [
        register(SHELL_ROUTES.state, ['GET'], () => handlers.state()),
        register(SHELL_ROUTES.asset, ['GET'], (request) => handlers.asset(request)),
        register(SHELL_ROUTES.generate, ['POST'], () => handlers.generate()),
        register(SHELL_ROUTES.dismiss, ['POST'], (request) => handlers.dismiss(request)),
      ];
      webCtx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose?.(); } catch { /* already gone */ }
        }
      }, 'maoxuan-pet.shell-routes');
    });
  }

  // Start the clock only after the persisted snapshot is loaded.
  void ready.then(() => {
    if (!cfg.enabled) return;
    arm();
  });

  // Exposed for tests and for the client's first paint.
  return { snapshot, runOnce, config: cfg };
}

export default { name, inject, apply };
