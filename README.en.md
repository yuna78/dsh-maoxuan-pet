# dsh-maoxuan-pet · Xiao Mao, the whale-girl desktop pet

[![verify](https://github.com/yuna78/dsh-maoxuan-pet/actions/workflows/verify.yml/badge.svg)](https://github.com/yuna78/dsh-maoxuan-pet/actions/workflows/verify.yml) [![npm](https://img.shields.io/npm/v/dsh-plugin-maoxuan-pet.svg)](https://www.npmjs.com/package/dsh-plugin-maoxuan-pet)

A floating pet living in the DeepSeek Harness (dsh) web shell. Every hour she reads one
essay from *Selected Works of Mao Zedong*, turns it into **one ≤200-character nudge** for a
founder — a verbatim quote or excerpt, one line of pressure in her own voice, and one rule
with a way to verify it — and shows it in a red-book speech bubble.

![bubble](docs/screenshot-hero.png)

> 中文说明见 [README.md](README.md)。

## What it does

| Piece | Behaviour |
|---|---|
| Pet | 4 sprite frames (idle / talk / blink / read), draggable, position remembered |
| Bubble | dark-red "book cover" with a gold spine; anchored to the **left** of the pet, so the pet never moves; `收起` / `再督促` are text-only buttons |
| Reading | opening the card marks that bubble read — the unread badge disappears; the bubble you are reading never gets swapped out |
| History | `‹ ›` walks back through previous bubbles; with nothing unread you still see the last one produced |
| Timing | one generation per hour (`everySeconds`), quiet hours, `maxBubbles` history cap |
| Preset | `maoxuan-pet` — a "Selected Works startup advisor" preset with the bundled corpus registered as the `maoxuan-vademecum` skill |

## Install

```bash
dsh plugin --profile web add dsh-plugin-maoxuan-pet
# restart dsh web (Ctrl+C, then `dsh web` again), reload the page
```

Requirements: dsh `>=0.2.1-rc.2 <0.3.0`, Node `^22.19.0 || >=24.0.0`. Web shell only.

## How a bubble is produced

```
everySeconds → pick next verified essay → template rotates quote/excerpt/summary
             → spawn `dsh --profile headless --json "<prompt>"` (60s-ish, one model call)
             → parse JSON {pua, lesson, axis, gist}
             → quote/excerpt must match the corpus verbatim, otherwise fall back to summary
             → fitLesson(): cite + pua + lesson ≤ 200 chars
             → persist to $DSH_HOME/storages/dsh-maoxuan-pet.json (atomic write)
             → client polls /api/dsh-maoxuan-pet.state every 20s
```

If the model call fails (no credentials, timeout, non-JSON), the plugin degrades to a **local
excerpt** and labels it `离线摘录` in the footer — it never invents a quote.

- Templates: `quote` (golden line) / `excerpt` (verbatim whole sentences) / `summary` (her own gist).
- Lesson axes: 客户 customers / 项目 projects / 组织 organisation / 现金流 cash flow / 决策 decisions / 自律 self-discipline.
- The 200-character cap is a hard invariant, not a suggestion: `fitLesson()` shrinks the lesson,
  never the quote.

## Config

```yaml
- id: dsh-maoxuan-pet
  config:
    enabled: true
    everySeconds: 3600      # hourly
    firstDelaySeconds: 90
    quietHours: [2, 8]      # no pings between 02:00 and 08:00 local time
    maxBubbles: 40
    headless: true          # false = only local excerpts, zero model calls
    profile: headless
    timeoutMs: 180000
    businessContext: "40, indie developer, small-tool SaaS"
```

## Verification

```bash
node verify/smoke.mjs        # 24 structural checks
node verify/contract.mjs     # 38 pure-function tests
node verify/host.test.mjs    # 18 fake-ctx end-to-end tests (no network, no subprocess)
node scripts/audit-corpus-coverage.mjs   # quote must be verbatim in all 33 essays
npm pack --dry-run           # 57 files, no .dsh-dev / assets/raw / verify
```

CI runs the same set on Node 22 and 24. See [verify/README.md](verify/README.md).

## License and third-party content

- **Code**: MIT — see [LICENSE](LICENSE).
- **Bundled corpus** (`corpus/`, 33 essays): **not MIT.** Texts come from the
  [Chinese Marxist Internet Archive](https://www.marxists.org/chinese/maozedong/index.htm) and
  are bundled for personal study only. See [NOTICE](NOTICE). Delete `corpus/articles/` to drop it;
  quote/excerpt templates then degrade safely to summary.
- **Sprites**: AI-generated (gpt-image-2), a fan-made "whale girl" character — not affiliated with
  DeepSeek. See [assets/PROVENANCE.md](assets/PROVENANCE.md).

This plugin is a reading/nudging tool that treats the essays as a source of product and
entrepreneurship method. It is not affiliated with DeepSeek or any publisher, and it is not
political advocacy.
