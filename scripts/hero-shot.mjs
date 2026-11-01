// 拍一张干净的 README 特写：只含宠物 + 完整气泡，2x 设备像素比（开发用，不进 CI）。
//
// 前置：1) 一个 dsh web 实例（建议隔离 DSH_HOME）；2) headless Chrome：
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --disable-gpu --remote-debugging-port=9333 --window-size=1920,1080 about:blank
// 用法：node scripts/hero-shot.mjs "http://127.0.0.1:3097/?token=…" docs/screenshot-hero.png
// 说明：裁剪区域只包含气泡与宠物；顶部不留白，避免把相邻浮层的碎片拍进去。
import { writeFileSync } from 'node:fs';

const [url, out] = process.argv.slice(2);
const v = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
let id = 1;
const p = new Map();
const send = (m, q = {}, s) => new Promise((res, rej) => { const i = id++; p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: q, sessionId: s })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const x = p.get(m.id); p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false }, sessionId);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
await send('Page.navigate', { url }, sessionId);
await new Promise((r) => setTimeout(r, 12000));

const ev = async (x) => {
  const res = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, sessionId);
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result?.value;
};

// 打开气泡（挂载时不会自动打开已存在的旧气泡），并把可能存在的引导弹窗移出视口
console.log('open card:', await ev(`(() => {
  const pet = document.querySelector('.mp-pet');
  if (pet) pet.click();
  // 不要隐藏任何 overlay：shell.overlay 槽位也是 overlay 类名，会把插件自己藏掉。
  return document.querySelectorAll('[role="dialog"]').length;
})()`));
await new Promise((r) => setTimeout(r, 900));

const rect = await ev(`(() => {
  const card = document.querySelector('.mp-card');
  const pet = document.querySelector('.mp-pet');
  if (!card || !pet) return null;
  const a = card.getBoundingClientRect();
  const b = pet.getBoundingClientRect();
  // 顶部不留白：上边缘可能有别的浮层碎片（插件面板等），裁掉更干净。
  const pad = 18;
  const x = Math.max(0, Math.min(a.left, b.left) - pad);
  const y = Math.max(0, Math.min(a.top, b.top));
  const right = Math.min(window.innerWidth, Math.max(a.right, b.right) + pad);
  const bottom = Math.min(window.innerHeight, Math.max(a.bottom, b.bottom) + pad);
  return { x, y, width: right - x, height: bottom - y };
})()`);
console.log('clip:', rect);
if (!rect) throw new Error('card/pet 未渲染');

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 2 },
  captureBeyondViewport: false,
}, sessionId);
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out, 'cssSize', Math.round(rect.width) + 'x' + Math.round(rect.height), 'px2x', Math.round(rect.width * 2) + 'x' + Math.round(rect.height * 2));

// 断言：截图区域内没有可见弹窗，且卡片完整在视口内
console.log('assert:', await ev(`(() => {
  const CLIP = ${JSON.stringify(rect)};
  const card = document.querySelector('.mp-card');
  const r = card.getBoundingClientRect();
  const vis = (el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(vis);
  return JSON.stringify({
    dialogVisible: dialogs.filter((d) => {
      const r = d.getBoundingClientRect();
      return r.right > CLIP.x && r.left < CLIP.x + CLIP.width && r.bottom > CLIP.y && r.top < CLIP.y + CLIP.height;
    }).length,
    cardFullyInViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    cardSize: [Math.round(r.width), Math.round(r.height)],
    chipColor: getComputedStyle(document.querySelector('.mp-axis')).backgroundColor,
    buttons: [...document.querySelectorAll('.mp-btn')].map((b) => getComputedStyle(b).borderTopWidth + '/' + getComputedStyle(b).backgroundColor),
  });
})()`));
ws.close();
