/**
 * Web half of `dsh-plugin-maoxuan-pet`.
 *
 * Renders「鲸鱼娘·小毛」into the Harness shell overlay: a floating pet in the
 * bottom-right corner plus a short speech bubble — one 毛选 line (原文 / 节选 /
 * 小毛概括), one nag in the pet's own voice, one lesson with an axis chip.
 * The whole bubble is budgeted at 200 characters by the host; the client never
 * pads it back out.
 *
 * Everything shown comes from `/api/dsh-maoxuan-pet.state`. When the host
 * reports `mode: "offline"` the bubble says so, because a local excerpt is not
 * a generated thought.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-maoxuan-pet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const API = {
      state: '/api/dsh-maoxuan-pet.state',
      generate: '/api/dsh-maoxuan-pet.generate',
      dismiss: '/api/dsh-maoxuan-pet.dismiss',
    };
    const POLL_MS = 20000;
    const POLL_BUSY_MS = 3000;
    const POS_KEY = 'dsh-maoxuan-pet.pos';
    const PET_H = 132;
    // 红皮书里只能有暖色：落点用同一族金色区分，别把蓝紫绿塞进红封面。
    const AXIS_COLOR = {
      客户: '#f7d9a4',
      项目: '#f0b478',
      组织: '#e9c887',
      现金流: '#e8ac52',
      决策: '#efd9b6',
      自律: '#d7a76b',
    };

    // 「红色精神」：卡片就是一本红皮书——深红封面、烫金书脊、米白内文。
    // 红色只用于封面、书脊与标题，正文用米白保证对比度；卡片绝对定位在宠物
    // 左侧，开合不会推动宠物，点击位置与宠物位置互不影响。
    const CSS = `
      [data-maoxuan-pet]{position:fixed;z-index:86;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#ffe9d6;font-size:13px;line-height:1.6}
      [data-maoxuan-pet] *{box-sizing:border-box}
      .mp-anchor{position:relative;display:flex;flex-direction:column;align-items:center}
      .mp-pet{position:relative;z-index:1;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;cursor:grab;user-select:none;transition:transform .25s ease}
      .mp-pet:active{cursor:grabbing}
      .mp-pet:hover{transform:translateY(-3px)}
      .mp-img{display:block;height:${PET_H}px;width:auto;max-width:140px;object-fit:contain;filter:drop-shadow(0 10px 16px #050b14aa)}
      .mp-img[data-talking="on"]{animation:mp-bob 1.6s ease-in-out infinite}
      .mp-fallback{height:${PET_H}px;width:100px;filter:drop-shadow(0 10px 16px #050b14aa)}
      .mp-tag{margin-top:2px;font-size:10px;font-weight:700;letter-spacing:.06em;color:#ffe2bd;background:#5c0f0fd9;border:1px solid #ffd9a833;border-radius:999px;padding:2px 8px;white-space:nowrap;backdrop-filter:blur(8px)}
      .mp-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:#f6cf9a;box-shadow:0 0 6px #f6cf9aaa;vertical-align:1px}
      .mp-dot[data-off="off"]{background:#fca5a5;box-shadow:0 0 6px #fca5a5aa}
      /* 红皮书封面：卡片脱离文档流，挂在宠物左侧，宠物自己不动 */
      .mp-bubble{position:absolute;z-index:2;right:calc(100% + 12px);bottom:30px;width:min(340px,calc(100vw - 32px));animation:mp-in .16s ease-out}
      .mp-anchor[data-side="right"] .mp-bubble{right:auto;left:calc(100% + 12px)}
      .mp-card{position:relative;max-height:min(58vh,480px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#f6cf9a #5f1010dd;color:#fff3e4;border:1px solid #8f1616;border-radius:12px;background:linear-gradient(155deg,#b32323 0%,#941a1a 46%,#771111 100%);box-shadow:0 22px 54px #35040466,0 0 0 1px #ffd9a814 inset}
      /* 滚动条必须配得上红皮书：烫金滑块 + 深红轨道，不要系统灰 */
      .mp-card::-webkit-scrollbar{width:8px;height:8px}
      .mp-card::-webkit-scrollbar-track{background:#5f1010cc;border-radius:8px}
      .mp-card::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#f7d9a4,#d09a3f);border-radius:8px;border:1px solid #5f1010}
      .mp-card::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,#ffe9c4,#e0aa4d)}
      .mp-card::-webkit-scrollbar-corner{background:#5f1010}
      /* 烫金书脊 */
      .mp-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;border-radius:11px 0 0 11px;background:linear-gradient(180deg,#f7d9a4,#d09a3f 45%,#b8792a);opacity:.92}
      /* 指向宠物的小箭头（挂在外层，避免被卡片滚动区裁掉） */
      .mp-tail{position:absolute;right:-5px;bottom:38px;width:10px;height:10px;background:#8f1616;border-right:1px solid #8f1616;border-top:1px solid #8f1616;transform:rotate(45deg)}
      .mp-anchor[data-side="right"] .mp-tail{right:auto;left:-5px;border-right:0;border-top:0;border-left:1px solid #8f1616;border-bottom:1px solid #8f1616}
      .mp-head{display:flex;align-items:center;gap:6px;padding:9px 8px 8px 14px;border-bottom:1px solid #ffd9a82e;cursor:grab}
      .mp-head:active{cursor:grabbing}
      .mp-state{flex:1;min-width:0;font-size:10.5px;font-weight:750;letter-spacing:.06em;color:#ffe0b6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mp-nav{border:0;background:none;color:#ffd9a8;font-size:15px;line-height:1;padding:1px 4px;cursor:pointer;border-radius:4px;opacity:.8}
      .mp-nav:hover:not(:disabled){color:#fff8ee;opacity:1}
      .mp-nav:disabled{opacity:.3;cursor:default}
      .mp-nav:focus-visible{outline:2px solid #f6cf9a;outline-offset:2px}
      .mp-close{border:0;background:none;color:#ffd9a8;font-size:16px;line-height:1;padding:2px 4px;cursor:pointer;border-radius:4px;opacity:.85}
      .mp-close:hover{color:#fff8ee;opacity:1}
      .mp-close:focus-visible{outline:2px solid #f6cf9a;outline-offset:2px}
      .mp-body{padding:10px 14px 11px 16px}
      .mp-cite{display:flex;gap:9px;margin:0 0 8px}
      .mp-rule{flex:0 0 auto;width:2px;border-radius:2px;background:#f6cf9a}
      .mp-cite-main{min-width:0}
      .mp-cite p{margin:0;font-size:13px;color:#fff8ee;white-space:pre-wrap;word-break:break-word}
      .mp-cite[data-kind="summary"] .mp-rule{background:#f0b57a}
      .mp-meta{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:10px;color:#f3cfa8}
      .mp-meta b{font-weight:750;color:#ffe0b6}
      .mp-pua{display:flex;gap:6px;margin:0 0 8px;font-size:13.5px;font-weight:750;color:#ffe7c2;letter-spacing:.01em}
      .mp-pua span:first-child{color:#ffcf8a;font-size:15px;line-height:1.35;font-weight:800}
      .mp-lesson{margin:0;font-size:12.5px;color:#ffeede}
      .mp-lesson b{color:#ffd08a;font-weight:750}
      .mp-axis{display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.08em;padding:1px 6px;border-radius:4px;margin-right:6px;color:#5a1208;vertical-align:1px}
      .mp-foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #ffd9a82a}
      .mp-src{flex:1;min-width:0;font-size:10px;color:#f0c9a2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mp-src a{color:#f0c9a2;text-decoration:none}
      .mp-src a:hover{color:#fff8ee;text-decoration:underline}
      .mp-offline{color:#f3cfa8;opacity:.9}
      /* 按钮不要盒子：只有文字，靠字重与下划线区分主次 */
      .mp-btn{border:0;background:none;padding:2px 3px;color:#ffe4c7;font:inherit;font-size:11.5px;font-weight:650;cursor:pointer;white-space:nowrap;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;text-decoration-color:#ffd9a84d;opacity:.92}
      .mp-btn:hover:not(:disabled){color:#fff8ee;text-decoration-color:#ffd9a8;opacity:1}
      .mp-btn:disabled{opacity:.5;cursor:default}
      .mp-btn:focus-visible{outline:2px solid #f6cf9a;outline-offset:2px;border-radius:4px}
      .mp-btn[data-primary="on"]{color:#fff3df;font-weight:800;text-decoration-color:#ffcf8a}
      .mp-loading{display:flex;align-items:center;gap:7px;color:#ffe7c2;font-size:12px;padding:6px 0}
      .mp-spin{width:12px;height:12px;border-radius:50%;border:2px solid #ffd9a83d;border-top-color:#f6cf9a;animation:mp-rot .8s linear infinite}
      .mp-empty{margin:0 0 8px;color:#ffe7c2;font-size:12.5px}
      .mp-warn{margin:6px 0 0;font-size:10px;color:#ffd0d0}
      .mp-badge{position:absolute;z-index:3;top:-7px;right:-7px;min-width:17px;height:17px;border-radius:9px;background:#f6cf9a;color:#6b1206;font-size:10px;font-weight:800;line-height:17px;text-align:center;padding:0 4px;box-shadow:0 4px 10px #2b040466}
      @keyframes mp-in{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
      @keyframes mp-rot{to{transform:rotate(360deg)}}
      @keyframes mp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
      @media (prefers-reduced-motion: reduce){
        [data-maoxuan-pet] *{animation:none!important;transition:none!important}
        .mp-pet:hover{transform:none}
      }
      /* 窄屏：不往左伸，改成从宠物上方往下展开，避免出屏 */
      @media (max-width:560px){
        .mp-bubble,.mp-anchor[data-side="right"] .mp-bubble{right:-6px;left:auto;bottom:calc(100% + 10px);width:min(340px,calc(100vw - 24px))}
        .mp-tail,.mp-anchor[data-side="right"] .mp-tail{right:26px;left:auto;bottom:-5px;border:0;border-right:1px solid #8f1616;border-bottom:1px solid #8f1616}
      }
    `;

    // --- position ------------------------------------------------------------
    const readPos = () => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null');
        if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
        return { x: saved.x, y: saved.y };
      } catch { return null; }
    };
    const writePos = (pos) => {
      try { window.localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* position is best effort */ }
    };
    const clampPos = (pos) => ({
      x: Math.max(8, Math.min(pos.x, window.innerWidth - 340)),
      y: Math.max(8, Math.min(pos.y, window.innerHeight - 180)),
    });

    // --- data ----------------------------------------------------------------
    const fetchState = async () => {
      const response = await fetch(`${API.state}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`state ${response.status}`);
      return response.json();
    };
    const post = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok && !payload?.running) throw new Error(`${url} ${response.status}`);
      return payload;
    };

    const mmss = (delta) => {
      if (!Number.isFinite(delta)) return '';
      const total = Math.max(0, Math.round(delta / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
    };

    /** v1 bubbles had quote/thought/insight/nag/action; render them too. */
    const shape = (bubble) => {
      if (!bubble) return null;
      if (bubble.cite && typeof bubble.cite.text === 'string') return bubble;
      return {
        ...bubble,
        template: bubble.quote ? 'quote' : 'summary',
        cite: { kind: bubble.quote ? 'quote' : 'summary', label: bubble.quote ? '原文' : '小毛概括', text: bubble.quote || bubble.thought || '' },
        axis: bubble.axis || '项目',
        pua: bubble.pua || bubble.nag || '',
        lesson: bubble.lesson || bubble.insight || bubble.action || '',
      };
    };

    /** Minimal whale: the PNGs live on the host and may 404 on a fresh checkout. */
    function FallbackWhale() {
      return h('svg', { className: 'mp-fallback', viewBox: '0 0 104 112', role: 'img', 'aria-label': '鲸鱼娘占位图' },
        h('ellipse', { cx: 52, cy: 62, rx: 34, ry: 30, fill: '#2f6fd0' }),
        h('ellipse', { cx: 43, cy: 82, rx: 22, ry: 14, fill: '#dbeafe' }),
        h('circle', { cx: 41, cy: 55, r: 5, fill: '#0b1220' }),
        h('circle', { cx: 63, cy: 55, r: 5, fill: '#0b1220' }),
        h('circle', { cx: 43, cy: 53, r: 1.6, fill: '#fff' }),
        h('circle', { cx: 65, cy: 53, r: 1.6, fill: '#fff' }),
        h('path', { d: 'M46 68 q6 5 12 0', stroke: '#0b1220', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M52 24 C 74 14, 92 26, 90 44 C 82 34, 68 34, 52 40 Z', fill: '#2f6fd0' }),
        h('path', { d: 'M78 6 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4 z', fill: '#ef4444' }));
    }

    function Pet() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState(readPos);
      const [spriteBroken, setSpriteBroken] = useState(false);
      const drag = useRef(null);
      const suppress = useRef(false);
      const seen = useRef(null);
      const closedIds = useRef(new Set());
      const marked = useRef(new Set());
      const autoFloor = useRef(null);
      const [pinned, setPinned] = useState(null);
      const [, setClock] = useState(0);

      const latest = shape(data?.current);
      const history = (data?.bubbles || []).map(shape).filter(Boolean);
      // While the card is open we keep showing the bubble it was opened with:
      // marking it read makes the host advance `current` to the next unread
      // bubble, and the text under the user's eyes must not swap out. With no
      // unread bubble left we still show the last one produced — an empty card
      // is never more useful than the card the user just read.
      const current = (pinned && history.find((b) => b.id === pinned))
        || latest
        || history[0]
        || null;
      const index = current ? history.findIndex((b) => b.id === current.id) : -1;
      const older = index >= 0 && index < history.length - 1;
      const newer = index > 0;
      const running = !!(data?.running || busy);
      const unread = Number(data?.unread || 0);
      const online = !error;
      const countdown = data?.nextRunAt ? Date.parse(data.nextRunAt) - Date.now() : NaN;

      const refresh = useCallback(async () => {
        try {
          const next = await fetchState();
          setData(next);
          setError(null);
          return next;
        } catch (failure) {
          // Keep the last good snapshot: a dropped poll must not blank the card.
          setError(String(failure?.message || failure));
          return null;
        }
      }, []);

      // One self-rescheduling poll; hidden tabs pause, in-flight generation
      // polls faster so the bubble lands without a manual refresh.
      useEffect(() => {
        let cancelled = false;
        let handle = null;
        const loop = async () => {
          if (cancelled) return;
          if (!document.hidden) await refresh();
          handle = window.setTimeout(loop, running ? POLL_BUSY_MS : POLL_MS);
        };
        void loop();
        const onVisible = () => { if (!document.hidden) void refresh(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          cancelled = true;
          if (handle) window.clearTimeout(handle);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [refresh, running]);

      // A newly generated bubble opens itself (the hourly timer included), and
      // closing it by hand keeps it closed until the next one arrives. Only
      // bubbles newer than the newest one seen at mount qualify, so reading a
      // card never pops the next old one open.
      useEffect(() => {
        if (!latest) return;
        const at = Date.parse(latest.at || '') || Date.now();
        if (autoFloor.current === null) { autoFloor.current = at; }
        if (seen.current === latest.id) return;
        seen.current = latest.id;
        if (at <= autoFloor.current) return;
        if (closedIds.current.has(latest.id)) return;
        autoFloor.current = at;
        setPinned(latest.id);
        setOpen(true);
      }, [latest?.id, latest?.at]);

      // Seeing the card means that bubble is read: the unread badge on the pet
      // disappears as soon as it is opened, not only after 收起.
      useEffect(() => {
        if (!open || !current || current.read) return undefined;
        const id = current.id;
        if (marked.current.has(id)) return undefined;
        const timer = window.setTimeout(async () => {
          marked.current.add(id);
          try {
            await post(API.dismiss, { id });
            setData((prev) => prev ? {
              ...prev,
              unread: Math.max(0, (prev.unread || 0) - (prev.current?.id === id ? 1 : 0)),
              bubbles: (prev.bubbles || []).map((b) => (b.id === id ? { ...b, read: true } : b)),
            } : prev);
          } catch { /* the next poll restores the truth */ }
        }, 600);
        return () => window.clearTimeout(timer);
      }, [open, current?.id, current?.read]);

      useEffect(() => {
        const handle = window.setInterval(() => setClock((n) => n + 1), 1000);
        return () => window.clearInterval(handle);
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          setOpen(false);
          setPinned(null);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open]);

      const dismiss = useCallback(async () => {
        const id = current?.id;
        if (id) closedIds.current.add(id);
        setOpen(false);
        setPinned(null);
        try {
          await post(API.dismiss, id ? { id } : {});
          setData((prev) => prev ? {
            ...prev,
            current: null,
            unread: Math.max(0, (prev.unread || 0) - 1),
            bubbles: (prev.bubbles || []).map((b) => (b.id === id ? { ...b, read: true } : b)),
          } : prev);
        } catch { /* the next poll restores the truth */ }
        void refresh();
      }, [current, refresh]);

      const regenerate = useCallback(async () => {
        setBusy(true);
        setOpen(true);
        try {
          await post(API.generate, {});
          await refresh();
        } catch (failure) {
          setError(String(failure?.message || failure));
        } finally {
          setBusy(false);
        }
      }, [refresh]);

      const startDrag = useCallback((event) => {
        if (event.button !== 0) return;
        suppress.current = false;
        const rect = event.currentTarget.closest('[data-maoxuan-pet]').getBoundingClientRect();
        drag.current = { sx: event.clientX, sy: event.clientY, ox: rect.left, oy: rect.top, moved: false };
        const move = (ev) => {
          const state = drag.current;
          if (!state) return;
          const dx = ev.clientX - state.sx;
          const dy = ev.clientY - state.sy;
          if (!state.moved && Math.abs(dx) + Math.abs(dy) > 4) state.moved = true;
          if (!state.moved) return;
          setPos(clampPos({ x: state.ox + dx, y: state.oy + dy }));
        };
        const up = () => {
          const state = drag.current;
          drag.current = null;
          suppress.current = !!state?.moved;
          if (state?.moved) setPos((prev) => { if (prev) writePos(prev); return prev; });
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      }, []);

      const sprite = () => {
        if (spriteBroken) return null;
        const sprites = data?.pet?.sprites || {};
        if (running) return sprites.read || sprites.idle || null;
        if (open && current && current.mode !== 'offline') return sprites.talk || sprites.idle || null;
        return sprites.idle || null;
      };

      const card = h('div', { className: 'mp-bubble' },
        h('i', { className: 'mp-tail', 'aria-hidden': true }),
        h('section', { className: 'mp-card', 'aria-label': '小毛的毛选督促' },
        h('div', { className: 'mp-head', onMouseDown: startDrag },
          h('span', { className: 'mp-state' }, current ? `《${current.title}》` : '鲸鱼娘·小毛'),
          history.length > 1
            ? h('button', {
              className: 'mp-nav', type: 'button', disabled: !newer,
              onClick: () => { if (newer) setPinned(history[index - 1].id); },
              title: '更新的一条', 'aria-label': '更新的一条',
            }, '‹')
            : null,
          history.length > 1
            ? h('button', {
              className: 'mp-nav', type: 'button', disabled: !older,
              onClick: () => { if (older) setPinned(history[index + 1].id); },
              title: '更早的一条', 'aria-label': '更早的一条',
            }, '›')
            : null,
          h('button', { className: 'mp-close', type: 'button', onClick: () => setOpen(false), 'aria-label': '收起气泡' }, '×')),
        h('div', { className: 'mp-body' },
          running ? h('div', { className: 'mp-loading' }, h('i', { className: 'mp-spin' }), '小毛正在翻毛选…') : null,
          current
            ? h(React.Fragment, null,
              h('blockquote', { className: 'mp-cite', 'data-kind': current.cite?.kind || 'quote' },
                h('i', { className: 'mp-rule', 'aria-hidden': true }),
                h('div', { className: 'mp-cite-main' },
                  h('p', null, current.cite?.kind === 'summary' ? current.cite.text : `「${current.cite.text}」`))),
              h('p', { className: 'mp-meta' },
                h('b', null, current.cite?.label || '原文'),
                current.year ? ` · ${current.year}` : ''),
              current.pua
                ? h('div', { className: 'mp-pua' }, h('span', { 'aria-hidden': true }, '“'), h('span', null, current.pua))
                : null,
              h('p', { className: 'mp-lesson' },
                current.axis
                  ? h('span', {
                    className: 'mp-axis',
                    style: { background: AXIS_COLOR[current.axis] || '#64748b' },
                    title: `启示落点：${current.axis}`,
                  }, current.axis)
                  : null,
                h('b', null, '启示 '),
                current.lesson),
              h('div', { className: 'mp-foot' },
                h('span', { className: 'mp-src' },
                  current.sourceUrl
                    ? h('a', { href: current.sourceUrl, target: '_blank', rel: 'noreferrer noopener' }, '中文马克思主义文库')
                    : '内置语料',
                  // 离线摘录不再用 chip 抢眼位，改成页脚一行小字，诚实但不喧宾夺主。
                  current.mode === 'offline' ? h('span', { className: 'mp-offline' }, ' · 离线摘录') : null),
                h('button', { className: 'mp-btn', type: 'button', onClick: dismiss, 'aria-label': '收起这条督促' }, '收起'),
                h('button', {
                  className: 'mp-btn', type: 'button', 'data-primary': 'on',
                  disabled: running, onClick: regenerate, 'aria-label': '再督促我一次',
                }, running ? '翻书中…' : '再督促')))
            : h(React.Fragment, null,
              h('p', { className: 'mp-empty' }, running ? '小毛正在翻第一篇毛选…' : '小毛还没读过毛选。'),
              h('button', {
                className: 'mp-btn', type: 'button', 'data-primary': 'on',
                disabled: running, onClick: regenerate, 'aria-label': '让小毛现在读一篇',
              }, running ? '翻书中…' : '现在读一篇')),
          data?.lastError ? h('p', { className: 'mp-warn' }, `上次生成没成功：${String(data.lastError.message || '').slice(0, 90)}`) : null,
          error ? h('p', { className: 'mp-warn' }, '连接中断，重试中…') : null)));

      const pet = h('div', {
        className: 'mp-pet',
        onMouseDown: startDrag,
        onClick: () => {
          if (suppress.current) { suppress.current = false; return; }
          if (open) { setOpen(false); setPinned(null); return; }
          setPinned(latest?.id || null);
          setOpen(true);
        },
        role: 'button',
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (open) { setOpen(false); setPinned(null); return; }
          setPinned(latest?.id || null);
          setOpen(true);
        },
        'aria-label': `鲸鱼娘小毛，${unread ? `${unread} 条未读` : '没有新督促'}，点开或收起`,
      },
      sprite() && !spriteBroken
        ? h('img', {
          className: 'mp-img',
          'data-talking': open && current && current.mode !== 'offline' ? 'on' : 'off',
          src: sprite(), alt: '鲸鱼娘·小毛', draggable: false, onError: () => setSpriteBroken(true),
        })
        : h(FallbackWhale, null),
      unread > 0 ? h('span', { className: 'mp-badge', 'aria-hidden': true }, unread > 9 ? '9+' : String(unread)) : null,
      h('span', { className: 'mp-tag' },
        h('i', { className: 'mp-dot', 'data-off': online ? 'on' : 'off' }),
        running ? '翻书中' : Number.isFinite(countdown) && countdown > 0 ? `${mmss(countdown)} 后再读` : '待命中'));

      const style = pos
        ? { left: pos.x, top: pos.y }
        : { right: 20, bottom: 96 };
      // The card hangs to the left of the pet. Only when the pet has been
      // dragged close to the left edge does it flip to the right side.
      const side = pos && pos.x < 380 ? 'right' : 'left';

      return h('div', { style, 'data-maoxuan-pet': true },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'mp-anchor', 'data-side': side }, pet, open ? card : null));
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-maoxuan-pet', order: 88,
      }, Pet));
    }

    return { apply, inject: ['slots'] };
  },
});
