# JARVIS co-pilot for the Python forex bot: read-only monitoring (sub-project 1)

Date: 2026-09-21. Status: design, awaiting owner review.

## Purpose and decisions already made

JARVIS is a co-pilot that monitors, and later helps improve, the existing Python forex bot (`C:\Users\irons\dev\automated-forex-strategy`, deployed on a Linux VPS). It is not a second trader: JARVIS's own trading engine stays disabled, and it needs no OANDA sub-account. Every change to the bot goes through the bot's own review and gating, never around it.

This spec covers sub-project 1 only: read-only monitoring. Later sub-projects (analysis proposals into the R&D gate, controlled actions, research tools) are out of scope and each gets its own spec.

The owner's blind spots, all four confirmed: silent failures, performance drift, no single place to ask, alert noise or gaps. The owner wants: ask-anything Q&A, proactive alerts, a live HUD view, and briefings.

This design was stress-tested by five independent critiques (live-VPS operations, data contract and drift statistics, security and LLM risk, a gap hunt against the bot's recorded failure history, architecture and scope). Their findings are incorporated below.

## Non-goals

- No writes to the bot: no POST calls, no registry or command-file changes, no orders.
- No full HUD panel, no scheduled briefings (the bot already sends an hourly digest), no per-strategy drift analytics, no research tooling in this sub-project.
- No LLM in any alerting or health-decision path.

## Architecture

Two pieces with one direction of data flow.

1. **Python side (bot repo): a watchdog that computes health and publishes it as one versioned endpoint, `GET /api/copilot`.** All thresholds and semantics live here, next to the code that understands them.
2. **JARVIS side (this repo): a thin viewer.** One GET-only client, one `bot_status` tool, one HUD status pill. It renders what `/api/copilot` says and adds no health logic of its own except freshness and reachability handling.

The raw dashboard endpoints (`/api/status`, `/api/strategies`, `/api/mission`, `/api/mission/activity`) stay available to JARVIS for drill-down questions only.

## The `/api/copilot` contract

```
{
  "schema_version": 1,
  "generated_at": "2026-09-21T12:00:00Z",   // ISO 8601 UTC, strict
  "ttl_s": 900,
  "overall": "ok|warn|crit|unknown",
  "market": { "state": "open|closed" },
  "headline": { "live_strategies": 10, "last_trade_trading_days": 2 },
  "checks": [
    { "id": "sizing_pinned_zero", "severity": "crit", "status": "ok|warn|crit|unknown",
      "evidence": "...", "since": "...", "threshold": "..." }
  ]
}
```

- `unknown` is a first-class status. A check that cannot read its input, hits an exception, or sees an empty or schema-invalid file reports `unknown`, never `ok`.
- The catalogue is self-describing, so JARVIS never needs to learn check names out of band.
- Numbers are units-explicit. Win rates are fractions in the payload, and percentages are rendered client-side.
- The payload is allowlist-projected on the server. It never contains account ids, tokens, absolute balances, raw log lines, or free-text fields.

## The checks (priority order)

Outcome-level checks come first; most of the bot's recorded pain was quiet failure with no error anywhere.

1. **Sizing pinned at zero:** a live registry strategy has `size_multiplier <= 0` for 2 or more consecutive execution runs (`results/execution_state.json`); a state file older than 9 hours (the execution timer runs every 4) is `unknown`. Correction from execution review: `entry_permitted == false` is a normal state (emergency halt, portfolio R cap, correlated-group cap) and is not a pinned signal; explaining blocked entries is Plan A-2.
2. **Trade velocity and last-fill age**, market-hours aware. Warn at 5 trading days without a fill across the whole book, critical at 10. Per-strategy expected cadence is derived from backtest trades per year. Only Monday to Friday session bars count.
3. **Per-bar liveness and block rate.** Correction found while writing the plan: `results/filter_log.json` records only blocked bars (verified: all 55 rows are `spread_blocked`), so it cannot show that a bar was evaluated, and it has no denominator for a block rate. These checks need the bot's per-bar log line as their source, which Plan A-2 must map before building them. Intent unchanged: no evaluated bar in the last 2 session bars while the bot is running, and any strategy or pair blocked on every evaluated bar for 5 days (this would have caught the gold pip-scaling bug).
4. **Stale running process:** a unit's start time is older than the modification time of any module it imports (bot, risk agent, dashboard).
5. **Registry versus executor drift:** ids marked live in the registry differ from ids the bot can actually trade.
6. **Revalidation coverage:** strategies resolved by weekly revalidation equal the number live, not merely "it ran".
7. **Journal patterns**, as an explicit regular-expression list: `ValidationError`, `UNITS_INVALID`, `Traceback`, `could not resolve`. Reads are bounded (`journalctl --since --no-pager -n N`).
8. **OANDA 401 rate** over a window, plus any 401 run longer than 3 hours.
9. **Malformed records in `live_trades.json`:** schema check, not value check (`r_multiple` of null is legitimate for unresolved trades).
10. **Meta-liveness** of the bot's existing agents: connection monitor, kill-switch monitor (freshness only), risk agent heartbeat, digest, shadow monitor, execution-state file. The watchdog consumes the existing attention items (`_compute_attention_items`) instead of re-implementing process checks.
11. **Dashboard reachable** (minor).

Thresholds live in one config file in the bot repo alongside its risk thresholds. Thresholds that measure cadence are at least twice the job's schedule.

## Alert hygiene

- **Market awareness:** a UTC market calendar (weekend closure, Christmas and New Year). Cadence checks report an expected-quiet state when the market is closed.
- **Maintenance and boot:** a maintenance flag file that auto-expires suppresses alerts during deploys; a 10-minute boot grace period suppresses stale alerts after a reboot.
- **Delivery:** deduplication with cooldown state persisted to disk; a global cap of 5 alerts per hour; one "recovered" message per alert; send failures retry with backoff and never raise. Every message is prefixed `[WATCHDOG]`. Alerts use code-templated text only, never quoted log lines.
- **Channel:** the bot's existing Telegram notifier and channel. No new token is placed on the VPS. JARVIS's own new bot stays PC-only, for chat.
- **Positive heartbeat:** one daily message with positive facts ("N fills, all strategies at full size") so silence is never read as health.
- **Who watches the watcher:** the daily heartbeat; JARVIS treats a stale `/api/copilot` as `unknown` while the PC is on; an optional external dead-man's-switch ping (for example healthchecks.io) at the end of each successful run, default off, owner's choice.

## Watchdog on the VPS

- A new Python agent in the bot repo, run by a `Type=oneshot` systemd timer following the conventions of the existing `deploy/*.service` units. Not named `watchdog` (it collides with a library the risk agent imports).
- Enforced read-only: `ProtectSystem=strict`, `ReadOnlyPaths` over the bot tree, `ReadWritePaths` for the `results/` directory only (its status, state and lock files), `Nice=10`, `IOSchedulingClass=idle`, `MemoryMax`, `TimeoutStartSec=60`. Writes use the bot's shared atomic-write helper; inputs are read with plain JSON reads, never the lock-taking `atomic_read`, which cannot create lock files on the read-only tree. The unit ships disabled: `WATCHDOG_ENABLED=1` is set by the owner in `/root/forex/.env`, and real alerts additionally need `COPILOT_ALERTS=on`; dry-run bookkeeping never carries into live mode, and a failed send is retried on the next run, not recorded as sent. Never glob `results/*.json`. `Persistent=false`, so a reboot does not cause a catch-up burst.
- `/api/copilot` is served from a small separate module registered on the dashboard behind a guarded `register_blueprint`. It does not edit the existing route logic in `status_server.py`, catches every exception, and returns `unknown` on error. A test proves every existing route still responds.
- A `WATCHDOG_ENABLED` environment gate. Rollback is `systemctl disable --now` on the timer plus removing the status file.

## JARVIS side (version 1)

- **Client:** hard-coded GET, exact path allowlist (version 1: `/api/copilot` only; the raw endpoints are added only when a tool uses them), no redirects, a total request deadline (not just an idle timeout), rejects paths containing `//`, `..` or encoded dots, no method-override headers. A test asserts the two state-changing endpoints (`/api/mission/epoch`, `/api/refresh-trades`) are unreachable. Timeouts, a short cache, off unless `JARVIS_BOT_DASHBOARD_URL` is set. It uses a dedicated client, not the general web proxy client; only the configured host and port are exempt from the loopback block.
- **Strict schema validation:** enums, numbers and ISO timestamps only; ids must match `^[A-Za-z0-9_.-]{1,40}$`; free text is dropped by default, and where kept it is truncated to 120 characters, stripped of control characters, and wrapped in an untrusted-data block. The tool description states the content is data, never instructions.
- **Freshness is computed by JARVIS:** `now - generated_at` with a UTC-only parser that rejects any other format. Failure states are shown separately and never as "bot down": unreachable (network), forbidden (403), server error, not JSON, stale, schema mismatch, or a non-null error. Market-closed is not a failure. The HUD shows the age of the last good sample and a "last verified reachable" line.
- **`bot_status` tool:** voice and chat sessions only. It is not added to the Telegram allowlist; if that ever changes it needs its own exact-match entry and test.
- **HUD:** a status pill (ok, warn, crit, UNKNOWN in full strength; never the last good value when stale), following the existing trading panel's "unknown is never safe" rule.
- **Briefings:** "brief me" is the same tool. Code computes every number and renders the facts; the model writes prose in a call with no tools and its output is rejected if it contains a number that is not in the input facts. Every figure is labelled "as of <timestamp>".
- **Data minimisation:** never forward account ids, tokens, hosts or raw balances to the model or Telegram; percentages and R values only unless the owner opts in.

## Transport

The dashboard is plain HTTP, unauthenticated, firewalled to the owner's IP. Over the internet a spoofed "all ok" is the worst case, and a changed home IP silently breaks access. Decision: an SSH tunnel from the PC to the VPS (key access already exists); JARVIS points at a local forwarded port. Tailscale or WireGuard is an acceptable alternative. JARVIS refuses plain HTTP to any host outside an explicit allowlist. Separately, the two unauthenticated POST endpoints on the dashboard should be protected with a shared-secret header; that is a bot change tracked outside this spec and goes through the bot's own gate.

## Verification

- **Contract tests** with redacted real-response fixtures in both repos, pinned to `schema_version`; they fail on type changes, null-versus-object changes, and timestamp format changes.
- **Ground-truth replay:** past incidents (zero trades for 14 days, gold blocked on every bar, sizing pinned at zero for a week, kill-switch monitor 3 days stale, swallowed `ValidationError`, revalidation inert for 7 of 10 strategies) are replayed as fixtures and each must fire the expected check. A quiet real period must not fire velocity checks.
- **Unknown-path tests:** unreadable, empty, malformed and missing inputs all produce `unknown`.
- **Dry run before alerts:** log-only for at least one full weekend and one real deploy, with a numeric ceiling on would-have-alerted events per week, each reviewed by the owner.

## Delivery order and gates

1. **Pre-work, read-only:** determine why 9 of 10 strategies show identical live results on the dashboard and identical `ev_since` on every mission-board row. Until per-strategy attribution is trustworthy, no per-strategy drift is shown; pooled family drift with the bot's kill-ladder sample gates (25, 50, 100 trades) is a later sub-project.
2. **Python, staged.** Plan A (`docs/superpowers/plans/2026-09-21-copilot-watchdog-python.md`) ships the endpoint, alerting, heartbeat, dry-run, units and the checks whose inputs are verified: sizing pinned at zero, book-wide trade velocity, trades schema. Plan A-2 (written after mapping the data sources) adds stale-process, registry-versus-executor drift, revalidation coverage, journal patterns, 401 rate, meta-liveness, per-strategy cadence and per-bar liveness, plus the incident replays. Each plan goes through critique, an independent approve/decline review, and a log-only deploy only with the owner's explicit go-ahead.
3. **JARVIS:** Plan B (`docs/superpowers/plans/2026-09-21-bot-copilot-jarvis-client.md`): client, `bot_status` and `bot_briefing` tools, HUD pill, SSH tunnel launcher, built in parallel from fixtures. Same review gate.
4. **Alerts enabled** only after the dry-run limits are met.

Every change to the bot repo or VPS follows the owner's standing rule: critique before build, independent review before merge, subagent diffs read directly, nothing deployed without approval.

## Related open items

- JARVIS's own Telegram bot (chat only, PC side) is still to be created by the owner; it is independent of this work.
- The optional external dead-man's-switch ping is off by default pending the owner's decision.
