# Forex Data Feed — Design Spec

Status: Approved (pre-implementation)
Date: 2026-09-13
Scope: Phase 1 of a larger forex project (data feed → dashboard UI → backtesting → assisted trading). This spec covers **only the data feed**.

## Goal

Get live forex prices for a small set of major pairs flowing into the JARVIS bridge from an OANDA account, so that:
- JARVIS can answer spoken price questions ("what's EUR/USD at?")
- A future dashboard UI has a source to poll
- Later backtesting/trading phases have a stable data contract to build on

## Out of scope (future phases)

- Dashboard UI rendering
- Historical data / backtesting
- Placing trades or any account-mutating action

## Architecture

New module `bridge/forex.mjs`, imported by `bridge/server.mjs`. Follows existing bridge conventions:

- Outbound calls to OANDA go through `net.mjs`'s guarded fetch helpers (not raw `fetch`), consistent with the SSRF-guard convention used for `/img`/`/media`.
- The `/forex/prices` HTTP route is dispatched through the existing `handleRequest` path so it inherits the same origin-allowlist check as `/health`, `/img`, `/media` — it is not a separate, unguarded listener.
- The `forex_price` MCP tool is registered via `createSdkMcpServer` with a zod input schema, the same pattern used in `ui.mjs` for the `ui_*` tools.

### Data flow

1. On bridge startup, `forex.mjs` validates OANDA credentials with a single test fetch. If invalid/missing, it fails fast with a loud log — it does not silently retry forever.
2. A poller runs on `JARVIS_FOREX_POLL_INTERVAL_MS` (default 10000ms), fetching prices for `JARVIS_FOREX_PAIRS` from OANDA and updating an in-memory cache: `{ pair: { bid, ask, time, stale } }`.
3. The cache is populated **only** by the poll timer. Neither the HTTP endpoint nor the MCP tool ever triggers an on-demand OANDA call — both only read the cache. This guarantees a hammering client can't drive extra OANDA API volume against the account.
4. `forex_price` (MCP tool) and `GET /forex/prices` (HTTP) both read from the cache.

## Config (env vars)

Prefixed `JARVIS_` to match existing convention (`JARVIS_BRIDGE_PORT`, `JARVIS_ALLOW_WRITES`, etc.):

| Variable | Default | Notes |
|---|---|---|
| `JARVIS_OANDA_API_KEY` | — | required |
| `JARVIS_OANDA_ACCOUNT_ID` | — | required |
| `JARVIS_OANDA_ENV` | `practice` | `practice` or `live`. Selects OANDA's practice vs. live host (verify exact hostnames during implementation — see Open Items). |
| `JARVIS_OANDA_ALLOW_LIVE` | unset | Must be explicitly set to `true` for the bridge to start with `JARVIS_OANDA_ENV=live`. Mirrors the existing `JARVIS_ALLOW_WRITES` default-deny philosophy. Without it, `live` + missing this flag is a startup error, not a silent fallback. |
| `JARVIS_FOREX_PAIRS` | `EUR_USD,GBP_USD,USD_JPY` | Validated against a known-instrument list at startup. An invalid pair is dropped with a warning; it does not fail the whole batch. |
| `JARVIS_FOREX_POLL_INTERVAL_MS` | `10000` | Clamped to a sane min/max at startup (exact bounds TBD during implementation, but must reject e.g. `0` or absurdly large values). |

The resolved environment (`practice`/`live`) is logged loudly at boot, the same way the bridge already prints its model/effort choice.

## Polling behavior

- **In-flight guard:** if a poll's fetch hasn't resolved by the time the next tick fires, that tick is skipped — no overlapping requests.
- **Timeout:** each fetch has a bounded timeout; a hung request cannot stall the poller indefinitely.
- **Backoff on failure:** repeated failures back off exponentially up to a capped interval, rather than hammering OANDA at the fixed interval during an outage.
- **Market-hours awareness:** the Friday-evening–Sunday-evening close (and holidays) is treated as an expected, non-error state. OANDA signals this via `tradeable: false` or lack of price updates. During this window, cached prices are not marked `stale` in a way that reads as a fault, and no error is logged — this is expected market closure, not a data-feed failure.
- **Genuine failures** (network error, invalid token, invalid account ID, OANDA 5xx) are logged distinctly from market-closure, and cause the served price to be marked `stale: true` once past a staleness threshold.

## Error handling detail

- **Invalid/expired token** and **invalid account ID** are treated as terminal config errors: logged loudly and distinctly, not folded into the generic "transient failure, keep serving cache" path — a bad credential should be obvious to the user, not silently masked by stale data forever.
- **One bad instrument in `JARVIS_FOREX_PAIRS`**: validated and dropped at startup (see Config table), so it cannot cause OANDA to reject the entire batch request for all pairs.

## Logging

Every poll attempt (success or failure, excluding expected market-closure quiet periods) is logged as one structured line:

```
{ pair, bid, ask, time, latencyMs, ok }
```

This shape is chosen so that later phases (backtesting needs historical ticks; live trading needs an audit trail of prices used for decisions) can start from this same contract without a redesign.

## Security

- **No secrets in output:** `OANDA_API_KEY` and `OANDA_ACCOUNT_ID` never appear in `/health`, in `/forex/prices` responses, or in any error message that reaches the client. OANDA's REST URLs embed the account ID in the path (`/v3/accounts/{accountID}/...`); any logged or passed-through upstream error text must have this redacted.
- **Origin allowlist:** `/forex/prices` is gated the same way as other bridge HTTP routes — no bypass listener.
- **Live-trading safety rail:** see `JARVIS_OANDA_ALLOW_LIVE` above. This account will later be reused for trading (phase 4); pinning practice-by-default now prevents an accidental live-money mistake from day one.
- **Forward note for later phases:** any future order-placing tool (`forex_place_order` or similar) must be gated through the existing `decideTool()` effectful-tool gate (the same default-deny mechanism as `JARVIS_ALLOW_WRITES`), not special-cased. Not implemented in this phase — flagged so it isn't overlooked later.

## Testing

- Unit tests for the OANDA response parser against fixture JSON (valid response, `tradeable: false` response, error response shapes).
- Manual verification: bridge boot logs show resolved environment and successful credential check; `GET /forex/prices` returns current cache; asking JARVIS "what's EUR/USD?" returns a spoken price.
- Verify behavior across a simulated market-closed state (fixture) does not log as an error.

## Open items to resolve during implementation (not assumed here)

1. **Exact OANDA v20 API details must be verified against current OANDA docs before coding**, not assumed from this spec:
   - Exact pricing endpoint path (likely `/v3/accounts/{accountID}/pricing?instruments=...`, to be confirmed)
   - Exact practice vs. live hostnames (these are different hosts, not just a query flag)
   - Exact auth header scheme/casing
   - Current documented rate limits, to sanity-check the default poll interval
2. Whether polling (vs. OANDA's streaming pricing endpoint) is safely within rate limits at the chosen interval — decided in favor of polling for simplicity in this phase, but the rate-limit numbers should be checked against real docs, not assumed.
3. Exact min/max clamp values for `JARVIS_FOREX_POLL_INTERVAL_MS`.
