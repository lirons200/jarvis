# Forex Dashboard (Ticker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, chrome-gated forex ticker to the JARVIS HUD — floating pill chips showing live bid prices with up/down indicators against a session-start baseline, and a click-to-detail blade with bid/ask/spread/status.

**Architecture:** A new pure-logic module (`src/lib/forexTicker.ts`) computes direction/formatting and is unit-tested directly; a thin poller (also in that module) hits the bridge's existing `GET /forex/prices` and writes into a new `forex` slice on the Zustand store. A new `ForexTicker.tsx` component renders the chips and, on click, builds detail-blade HTML using the same `hud-*` class vocabulary the sanitiser already allows, then calls the existing `pushBlade` store action directly — no new bridge or MCP work needed beyond one flag (`ticker`) added to the existing `ui_chrome` tool.

**Tech Stack:** React + Zustand (existing), no new dependencies. Tests for the new pure logic run via Node's built-in test runner using the `tsx` loader (already a devDependency) so `.ts` files run directly, alongside the existing `node --test` setup from the phase 1 plan.

**Depends on:** Phase 1 (`C:\Users\irons\jarvis\docs\superpowers\specs\2026-09-13-forex-data-feed-design.md`), specifically `GET /forex/prices`.

**Spec:** `C:\Users\irons\jarvis\docs\superpowers\specs\2026-09-13-forex-dashboard-design.md`

---

## File Structure

- **Create:** `src/lib/forexTicker.ts` — types, direction/format helpers, detail-blade HTML builder, and the polling function.
- **Create:** `src/lib/forexTicker.test.ts` — unit tests for the pure helpers.
- **Create:** `src/ui/ForexTicker.tsx` — the chip-row component.
- **Modify:** `src/store.ts` — add `chrome.ticker`, add the `forex` slice and its actions.
- **Modify:** `src/ui/Hud.tsx` — mount `<ForexTicker />`, gated by `ui.chrome.ticker`.
- **Modify:** `src/App.tsx` — start the forex poller once on mount.
- **Modify:** `src/index.css` — chip styles.
- **Modify:** `bridge/ui.mjs` — add `ticker` to the `ui_chrome` tool's schema and description.
- **Modify:** `package.json` — add a frontend test script.

---

### Task 1: Pure helpers — direction, formatting, detail HTML

**Files:**
- Create: `src/lib/forexTicker.ts`
- Test: `src/lib/forexTicker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/forexTicker.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDirection, formatRelativeTime, buildDetailHtml } from './forexTicker'

test('computeDirection reports up when the bid rose above the baseline', () => {
  assert.equal(computeDirection(1.15, 1.1), 'up')
})

test('computeDirection reports down when the bid fell below the baseline', () => {
  assert.equal(computeDirection(1.05, 1.1), 'down')
})

test('computeDirection reports neutral when unchanged or no baseline yet', () => {
  assert.equal(computeDirection(1.1, 1.1), 'neutral')
  assert.equal(computeDirection(1.1, null), 'neutral')
})

test('formatRelativeTime renders seconds, minutes, and a floor of "just now"', () => {
  const now = 1_000_000
  assert.equal(formatRelativeTime(now, now), 'just now')
  assert.equal(formatRelativeTime(now - 4000, now), '4s ago')
  assert.equal(formatRelativeTime(now - 125_000, now), '2m ago')
})

test('buildDetailHtml renders a tradeable pair using only hud-* classes', () => {
  const html = buildDetailHtml('EUR_USD', {
    bid: 1.13015,
    ask: 1.13028,
    time: '2026-09-13T18:41:36Z',
    tradeable: true,
    stale: false,
    fetchedAtMs: 1000,
    baseline: 1.129,
  }, 5000)
  assert.match(html, /EUR_USD/)
  assert.match(html, /1\.13015/)
  assert.match(html, /1\.13028/)
  // spread = ask - bid, rounded to 5 decimal places
  assert.match(html, /0\.00013/)
  assert.match(html, /tradeable/)
  assert.doesNotMatch(html, /<script/i)
})

test('buildDetailHtml reports market closed for a non-tradeable pair', () => {
  const html = buildDetailHtml('EUR_USD', {
    bid: 1.13015,
    ask: 1.13028,
    time: '2026-09-13T18:41:36Z',
    tradeable: false,
    stale: false,
    fetchedAtMs: 1000,
    baseline: null,
  }, 5000)
  assert.match(html, /market closed/i)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/forexTicker.test.ts`
Expected: FAIL — `src/lib/forexTicker.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/forexTicker.ts`:

```ts
/**
 * Pure logic for the forex ticker — direction/formatting helpers and the
 * detail-blade HTML builder. Kept free of React and the store so it can be
 * unit-tested directly; ForexTicker.tsx and store.ts are the only callers.
 */

export type ForexPriceEntry = {
  bid: number | null
  ask: number | null
  time: string | null
  tradeable: boolean
  stale: boolean
  fetchedAtMs: number
  /** First bid seen for this pair this session. null until one arrives. */
  baseline: number | null
}

export type Direction = 'up' | 'down' | 'neutral'

/** Compares the current bid against the session-start baseline. */
export function computeDirection(bid: number, baseline: number | null): Direction {
  if (baseline === null) return 'neutral'
  if (bid > baseline) return 'up'
  if (bid < baseline) return 'down'
  return 'neutral'
}

/** "just now" / "4s ago" / "2m ago" — enough precision for a glanceable chip. */
export function formatRelativeTime(atMs: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - atMs) / 1000))
  if (deltaS < 3) return 'just now'
  if (deltaS < 60) return `${deltaS}s ago`
  return `${Math.round(deltaS / 60)}m ago`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Detail-blade body for a clicked chip. Built with only the `hud-*` classes
 * `sanitisePanelHtml` already allows (see src/ui/sanitise.ts) — this passes
 * through the exact same sanitiser as model-authored blades, even though it
 * is generated client-side, so there is exactly one trusted vocabulary for
 * blade markup rather than two.
 */
export function buildDetailHtml(
  pair: string,
  entry: ForexPriceEntry,
  nowMs: number,
): string {
  const bid = entry.bid
  const ask = entry.ask
  const spread = bid !== null && ask !== null ? (ask - bid).toFixed(5) : '—'
  const status = entry.stale
    ? 'stale'
    : entry.tradeable
      ? 'tradeable'
      : 'market closed'
  const changeRow =
    bid !== null && entry.baseline !== null
      ? `<div class="hud-row"><span class="hud-label">Since session start</span>` +
        `<span class="hud-metric">${(((bid - entry.baseline) / entry.baseline) * 100).toFixed(2)}%</span></div>`
      : ''

  return (
    `<div class="hud-rows">` +
    `<div class="hud-row"><span class="hud-label">Pair</span><span class="hud-main">${esc(pair)}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Bid</span><span class="hud-metric">${bid ?? '—'}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Ask</span><span class="hud-metric">${ask ?? '—'}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Spread</span><span class="hud-metric">${spread}</span></div>` +
    changeRow +
    `<div class="hud-row"><span class="hud-label">Last updated</span><span class="hud-sub">${esc(
      formatRelativeTime(entry.fetchedAtMs, nowMs),
    )}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Status</span><span class="hud-tag">${esc(status)}</span></div>` +
    `</div>`
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/forexTicker.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/forexTicker.ts src/lib/forexTicker.test.ts
git commit -m "forex-ui: add direction/format/detail-html pure helpers"
```

---

### Task 2: Polling function

**Files:**
- Modify: `src/lib/forexTicker.ts`

- [ ] **Step 1: Write the implementation**

No new unit test here — same reasoning as phase 1's `fetchPricingOnce`: this makes a real network call and is exercised by manual verification (Task 6). Append to `src/lib/forexTicker.ts`:

```ts
import { BRIDGE_HTTP_URL } from '../config'

type RawPrices = Record<
  string,
  { bid: number | null; ask: number | null; time: string | null; tradeable: boolean; stale: boolean; fetchedAtMs: number }
>

/**
 * Polls `GET /forex/prices` on the bridge every `intervalMs` and calls
 * `onUpdate` with the raw cache each time it succeeds. A failed fetch is
 * swallowed — the caller keeps whatever it last had, matching the bridge's
 * own "keep serving the last known price" philosophy. Returns a stop
 * function.
 */
export function startForexPolling(
  onUpdate: (prices: RawPrices) => void,
  intervalMs = 5000,
): () => void {
  let stopped = false

  const tick = async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/forex/prices`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        const data = (await res.json()) as { prices?: RawPrices }
        if (data.prices) onUpdate(data.prices)
      }
    } catch {
      // Bridge unreachable or forex disabled — leave the store as it is.
    }
    if (!stopped) setTimeout(tick, intervalMs)
  }

  void tick()
  return () => {
    stopped = true
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/forexTicker.ts
git commit -m "forex-ui: poll the bridge's /forex/prices endpoint"
```

---

### Task 3: Store — chrome flag and forex slice

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Add the chrome flag**

In `UiState['chrome']` (around line 136-142), add:

```ts
  chrome: {
    systems: boolean      // the left SYSTEMS rail
    transcript: boolean   // the conversation log
    toolBadge: boolean    // the active-tool readout under the reactor
    suggestions: boolean  // the "try saying…" hint
    brand: boolean        // the J.A.R.V.I.S. wordmark + status
    ticker: boolean       // the forex price ticker
  }
```

And in `UI_DEFAULTS` (around line 150):

```ts
  chrome: { systems: true, transcript: true, toolBadge: true, suggestions: true, brand: true, ticker: true },
```

No other change is needed for the chrome patch path — `UiPatch['chrome']` is already `Partial<UiState['chrome']>`, so `ticker` is covered automatically, and `applyUi`'s `{ ...s.ui.chrome, ...defined(patch.chrome) }` merge already handles the new key the same way as the rest.

- [ ] **Step 2: Add the forex slice**

Import the type near the top of `src/store.ts`:

```ts
import type { ForexPriceEntry } from './lib/forexTicker'
```

Add to the `State` type (near the other slices, e.g. after `ui: UiState`):

```ts
  /** Live forex prices, keyed by pair (e.g. "EUR_USD"). Empty until the
   *  first successful poll — the ticker only renders once this is non-empty. */
  forex: Record<string, ForexPriceEntry>
  setForexPrices: (
    raw: Record<string, { bid: number | null; ask: number | null; time: string | null; tradeable: boolean; stale: boolean; fetchedAtMs: number }>,
  ) => void
```

Add to the store's initial state (near `ui: defaultUi()`):

```ts
  forex: {},
```

Add the action implementation (near `applyUi`):

```ts
  // Captures each pair's baseline the first time it's ever seen this
  // session, and never overwrites it afterward — that's what "change since
  // session start" means. Existing baselines are carried forward from the
  // previous state on every poll.
  setForexPrices: (raw) =>
    set((s) => {
      const next: State['forex'] = {}
      for (const [pair, entry] of Object.entries(raw)) {
        const baseline = s.forex[pair]?.baseline ?? entry.bid
        next[pair] = { ...entry, baseline }
      }
      return { forex: next }
    }),
```

- [ ] **Step 3: Commit**

```bash
git add src/store.ts
git commit -m "forex-ui: add chrome.ticker flag and the forex price slice"
```

---

### Task 4: ForexTicker component

**Files:**
- Create: `src/ui/ForexTicker.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/ui/ForexTicker.tsx`:

```tsx
import { useStore } from '../store'
import { computeDirection, buildDetailHtml } from '../lib/forexTicker'

/**
 * The forex price ticker — a row of floating pill chips, one per pair.
 * Only renders once at least one price has arrived; chrome.ticker only
 * controls visibility of a feature that exists, it doesn't conjure data.
 */
export function ForexTicker() {
  const forex = useStore((s) => s.forex)
  const pushBlade = useStore((s) => s.pushBlade)
  const pairs = Object.keys(forex)

  if (pairs.length === 0) return null

  return (
    <div className="forex-ticker">
      {pairs.map((pair) => {
        const entry = forex[pair]
        const direction = entry.bid === null ? 'neutral' : computeDirection(entry.bid, entry.baseline)
        const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : ''
        const label = pair.replace('_', '/')

        return (
          <button
            key={pair}
            type="button"
            className={`forex-chip forex-chip-${direction}${entry.stale ? ' forex-chip-stale' : ''}`}
            onClick={() =>
              pushBlade({
                id: `forex-${pair}-${Date.now()}`,
                title: label,
                kind: 'markup',
                html: buildDetailHtml(pair, entry, Date.now()),
                size: 'compact',
                hold: 'turn',
              })
            }
          >
            <span className="forex-chip-pair">{label}</span>
            <span className="forex-chip-price">{entry.bid ?? '—'}</span>
            {arrow && <span className="forex-chip-arrow">{arrow}</span>}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/ForexTicker.tsx
git commit -m "forex-ui: add the ForexTicker chip-row component"
```

---

### Task 5: Wire into Hud, App, CSS, and the ui_chrome tool

**Files:**
- Modify: `src/ui/Hud.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `bridge/ui.mjs`

- [ ] **Step 1: Mount the ticker in the HUD**

In `src/ui/Hud.tsx`, import it:

```tsx
import { ForexTicker } from './ForexTicker'
```

Render it gated by the chrome flag, near the other chrome-gated elements (e.g. right after the `<header className="hud-top">` block, around line 208):

```tsx
      {ui.chrome.ticker && <ForexTicker />}
```

- [ ] **Step 2: Start polling once on mount**

In `src/App.tsx`, import the poller and the store setter:

```tsx
import { startForexPolling } from './lib/forexTicker'
```

Add a new `useEffect` alongside the other top-level effects (e.g. near the clap-to-start effect around line 544) — this one has no dependency on `phase`, since the ticker should poll regardless of whether JARVIS is powered on:

```tsx
  // Forex prices poll independently of the voice/power state — the ticker is
  // a passive HUD readout, not something the wake word gates.
  useEffect(() => {
    const stop = startForexPolling((prices) => store.getState().setForexPrices(prices))
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

- [ ] **Step 3: Add chip styles**

In `src/index.css`, add near the other HUD chrome rules (e.g. after the `.hud-rows` block around line 511):

```css
.forex-ticker {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  z-index: 5;
}

.forex-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(10, 20, 32, 0.85);
  border: 1px solid rgba(46, 230, 255, 0.3);
  border-radius: 20px;
  padding: 5px 12px;
  font: 500 11px/1.4 ui-monospace, monospace;
  color: var(--accent, #7fdcee);
  cursor: pointer;
}

.forex-chip-pair { opacity: 0.7; }
.forex-chip-up { color: #5fe0a0; border-color: rgba(95, 224, 160, 0.4); }
.forex-chip-down { color: #e05f5f; border-color: rgba(224, 95, 95, 0.4); }
.forex-chip-stale { opacity: 0.5; }
```

- [ ] **Step 4: Add the `ticker` flag to the `ui_chrome` MCP tool**

In `bridge/ui.mjs`, add to `chromeSchema` (around line 271-277):

```js
const chromeSchema = {
  systems: looseBool('The SYSTEMS rail down the left — connected servers and status.'),
  transcript: looseBool('The running conversation log.'),
  tool_badge: looseBool('The active-tool readout under the reactor.'),
  suggestions: looseBool('The "try saying…" hint.'),
  brand: looseBool('The J.A.R.V.I.S. wordmark and status line.'),
  ticker: looseBool('The forex price ticker along the top of the display.'),
}
```

And in the `ui_theme`... no — in the `ui_chrome` tool handler (around line 441-454), add the corresponding line:

```js
      tool('ui_chrome', CHROME_DESCRIPTION, chromeSchema, async (args) => {
        const chrome = {}
        put(chrome, 'systems', toBool(args.systems))
        put(chrome, 'transcript', toBool(args.transcript))
        put(chrome, 'toolBadge', toBool(args.tool_badge))
        put(chrome, 'suggestions', toBool(args.suggestions))
        put(chrome, 'brand', toBool(args.brand))
        put(chrome, 'ticker', toBool(args.ticker))

        if (!has(chrome)) return ok('No change — nothing was named.')
        emit('patch', { chrome })
        return ok('Chrome updated.')
      }),
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/Hud.tsx src/App.tsx src/index.css bridge/ui.mjs
git commit -m "forex-ui: mount the ticker, poll on boot, style chips, expose ui_chrome ticker flag"
```

---

### Task 6: Frontend test script and manual verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add a frontend test script**

In `package.json`, alongside the existing `"test"` script from the phase 1 plan, add:

```json
    "test:ui": "node --import tsx --test src/lib/**/*.test.ts",
```

And update `"test"` to run both:

```json
    "test": "node --test bridge/**/*.test.mjs && npm run test:ui",
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — bridge tests (phase 1) and the new `forexTicker.test.ts` tests all succeed.

- [ ] **Step 3: Manual verification**

With OANDA credentials configured (`npm run bridge` in one terminal, `npm run dev` in another, or `npm start`):

1. Open the app in Chrome — confirm the pill chips appear near the top once prices arrive (may take a few seconds for the first poll).
2. Watch a chip for a minute — confirm it turns green with ▲ or red with ▼ as the price moves relative to where it started.
3. Click a chip — confirm a blade opens showing pair, bid, ask, spread, change since session start, last updated, and status.
4. Say "hide the price ticker" — confirm JARVIS calls `ui_chrome` with `ticker: false` and the chips disappear; say "put it back" or similar to confirm it returns.
5. Stop the bridge (or unset the OANDA env vars and restart it) — confirm the ticker does not appear at all (no chips, no empty row).

---

## Self-Review Notes

- **Spec coverage:** floating pill chips → Task 4/5. `ui_chrome.ticker` toggle → Tasks 3 and 5 (both the store field and the MCP tool schema — a patch with no matching schema field would be silently dropped by `put`, so both sides had to be listed explicitly). Session-start baseline → Task 3's `setForexPrices` (captures once, never overwrites). Click → detail blade using existing blade/sanitiser machinery → Task 1 (`buildDetailHtml`, `hud-*` classes only) and Task 4 (`pushBlade` call). Only renders when feed enabled → Task 4's `pairs.length === 0` guard, driven by the store only ever getting entries once a real poll succeeds. Stale/closed states → Task 1's `buildDetailHtml` status branch and Task 5's `.forex-chip-stale` style.
- **No placeholders:** every step has complete code.
- **Type/name consistency check:** `ForexPriceEntry`, `computeDirection`, `formatRelativeTime`, `buildDetailHtml`, `startForexPolling`, `setForexPrices` are spelled identically everywhere they're referenced across store.ts, ForexTicker.tsx, and App.tsx.
