# Forex Dashboard (Ticker) — Design Spec

Status: Approved (pre-implementation)
Date: 2026-09-13
Scope: Phase 2 of the forex project (data feed → **dashboard UI** → backtesting → assisted trading). Depends on phase 1 ([2026-09-13-forex-data-feed-design.md](2026-09-13-forex-data-feed-design.md)), which already exposes `GET /forex/prices` on the bridge.

Mockups explored during brainstorming (layout options, ticker style variants, detail blade) are saved under `.superpowers/brainstorm/` in this repo for reference.

## Goal

Show live forex prices in the JARVIS interface as a persistent, glanceable HUD element, with a way to drill into one pair for more detail — without needing a chart or historical data yet (that's phase 3).

## Out of scope (future phases)

- Charts / historical price data (needs phase 3, backtesting, which introduces a real historical store)
- Any trading action from the dashboard

## Chosen design

**Layout — floating pill chips, persistent strip.** One rounded "chip" per configured pair (`EUR/USD  1.1302 ▲`), laid out in a row near the top of the interface, in the same soft/floating visual language as JARVIS's other HUD elements (blades, panels) rather than a bordered trading-terminal-style bar.

**Visibility — a new `ui_chrome` field.** Added to the existing chrome toggle set (`systems`, `transcript`, `toolBadge`, `suggestions`, `brand`) as `ticker`, defaulting to `true`. Follows the exact existing pattern: JARVIS can hide it with `ui_chrome({ ticker: false })` the same way he hides the systems rail, and it survives `ui_reset` the same way the others do (returns to default `true`).

**Only rendered when the forex feed is actually enabled.** If the bridge reports no forex data (feed disabled — no OANDA credentials configured), the ticker does not appear at all, regardless of the chrome flag. Chrome only controls visibility of a feature that exists; it does not conjure data that isn't there.

**Change indicator — session-start baseline.** The first price seen for each pair after the frontend starts polling is kept as that pair's reference price for the session. Each subsequent update compares against it: up → green chip text + ▲, down → red + ▼, unchanged → neutral, no arrow. This resets on a page reload, which is fine — phase 3 will introduce a real historical baseline (daily open, etc.) when there's an actual historical store to compute it from.

**Interactivity — click opens a detail blade.** Clicking a chip pushes a blade (reusing the existing `Blade`/`pushBlade` mechanism — `kind: 'markup'`, sanitised HTML, `hold: 'turn'`) showing:
- Bid, ask, spread (ask − bid)
- Change since session start (same baseline as the chip)
- Last updated (relative time, e.g. "4s ago")
- Status: `tradeable` or `market closed` (from the cached `tradeable` flag), and `stale` if the bridge has flagged it stale

This blade is pushed **client-side**, not authored by JARVIS through a tool call — it's a direct UI interaction, the same category of thing as opening the camera blade.

## Architecture

**Data flow:** the frontend polls `GET {BRIDGE_HTTP_URL}/forex/prices` on an interval (a new small module, `src/lib/forex.ts`, following the same shape as `src/lib/capabilities.ts`'s `/health` probe) and writes the result into the Zustand store. Nothing here talks to OANDA directly or goes through the WebSocket/MCP path — this is a plain HTTP poll of a bridge endpoint that already exists.

**Store additions (`src/store.ts`):**
- `UiState.chrome.ticker: boolean` (default `true`) — same pattern as the other chrome booleans, patchable via `UiPatch.chrome`.
- A new top-level `forex` slice: `{ prices: Record<string, ForexPriceEntry>, enabled: boolean }`, where `ForexPriceEntry` mirrors the bridge's cache shape (`bid`, `ask`, `time`, `tradeable`, `stale`, `fetchedAtMs`) plus a client-computed `baseline: number | null` (the session-start reference price, set once per pair on first sight and never overwritten).
- `enabled` is derived from whether `/forex/prices` has ever returned a non-empty `prices` object — this is what the ticker's "only render when the feed is enabled" rule reads from, so it doesn't need its own bridge flag.

**New UI component:** `src/ui/ForexTicker.tsx` — renders the pill-chip row, reads `forex.prices` and `ui.chrome.ticker` from the store, computes each chip's up/down/neutral state from `baseline`, and on click builds the detail blade HTML and calls `store.getState().pushBlade(...)`. Mounted from `Hud.tsx` alongside the other chrome-gated rails.

**MCP tool reused as-is:** phase 1's `forex_price` MCP tool needs no changes — it already exists for spoken queries and is independent of this visual ticker.

## Polling

The frontend poll interval does not need to match the bridge's OANDA poll interval exactly — polling `/forex/prices` every 5 seconds is reasonable regardless of the bridge's configured `JARVIS_FOREX_POLL_INTERVAL_MS`, since it's just reading a cheap in-memory cache on the bridge side (no OANDA call is triggered by this — see phase 1 spec's cache-only-read guarantee). If the fetch fails (bridge unreachable), the ticker keeps showing its last-known values rather than disappearing, consistent with the bridge's own stale-but-shown philosophy.

## Error/edge states

- **Feed disabled:** ticker doesn't render (see above).
- **Bridge unreachable:** ticker keeps last-known prices, no crash; a future refinement could dim the chips, but that's not required for this phase.
- **A pair is stale** (bridge-side `stale: true`): chip shows the price with a dimmed/muted treatment rather than a hard error — consistent with the detail blade's "market closed" framing, this is expected-quiet-market, not a fault the user needs to see as broken.
- **A pair is `tradeable: false`** (market closed): chip still shows the last price, no arrow (nothing to compare against right now), and the detail blade says "market closed" plainly.

## Testing

- Unit test the up/down/neutral computation and the baseline-capture logic (pure function, testable the same way as phase 1's `parsePricingResponse` — via `node --test`, extracted into a plain function rather than embedded in the React component).
- Manual verification: start the bridge with OANDA credentials configured, open the frontend, confirm the ticker appears with the three configured pairs, confirm colors/arrows update as prices move, confirm `ui_chrome({ ticker: false })` (spoken: "hide the price ticker") hides it, confirm clicking a chip opens the detail blade with correct values, confirm the ticker doesn't appear at all when the bridge has no OANDA credentials configured.
