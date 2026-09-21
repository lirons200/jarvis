# Co-pilot Watchdog (Python, bot repo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only watchdog to the Python forex bot that computes outcome-level health checks, publishes them as a versioned `GET /api/copilot` payload, and (only when enabled) sends deduplicated Telegram alerts through the bot's existing notifier.

**Architecture:** A new package `src/agents/copilot/` holds pure, unit-tested checks, an alert planner, and a runner that reads existing state files, writes `results/copilot.json` and `results/copilot_state.json`, and optionally sends alerts. A tiny Flask blueprint serves the payload, registered behind a guard so it can never break the dashboard. A hardened `Type=oneshot` systemd timer runs it every 15 minutes. Dry-run is the default; real sending needs `COPILOT_ALERTS=on`.

**Tech Stack:** Python 3.13, pytest, Flask, the repo's `src.agents.shared.state_reader` (`atomic_read`, `atomic_write`) and `telegram_notifier.send_telegram`.

**Spec:** `C:\Users\irons\jarvis\docs\superpowers\specs\2026-09-21-bot-copilot-monitoring-design.md`. This plan implements the checks whose inputs were verified against real files: `sizing_pinned_zero`, `trade_velocity` (book-wide), `live_trades_schema`, plus the payload, endpoint, alerting, heartbeat, dry-run, maintenance flag, boot grace, dead-man ping and systemd units. A follow-up plan (Plan A-2) adds the remaining checks (stale process, registry-vs-executor drift, revalidation coverage, journal patterns, 401 rate, meta-liveness, per-strategy cadence, per-bar liveness) once their data sources are mapped. `filter_log.json` records only blocked bars (verified: 55 of 55 rows are `spread_blocked`), so per-bar liveness must not be built on it.

**Hard rules for this plan:** work only in a git worktree of the bot repo, never in `C:\Users\irons\dev\automated-forex-strategy` itself (it has uncommitted changes and is one commit ahead of origin); never touch the VPS, never SSH, never deploy; never read or print `.env`; write nothing except the files listed; every task is TDD with a commit.

**Conventions verified in the repo:** tests live under `tests/agents/<pkg>/` with an `__init__.py`; `from scripts import status_server` imports cleanly in tests; `app = Flask(__name__)` is at `scripts/status_server.py:65` and `BASE_DIR` is defined at line 35; `logging` is not imported there; systemd units use `Type=oneshot`, `User=root`, `WorkingDirectory=/root/forex`, `EnvironmentFile=/root/forex/.env`, and journal output; `execution_state.json` is `{"updated_at": ISO, "strategies": {sid: {"size_multiplier", "entry_permitted", ...}}, "global": {...}}`; the registry is `config/strategy_registry.json` (dict of sid to config; live means `cfg.get("live") or cfg.get("status") == "live"`); `live_trades.json` is `{"trades": [ {timestamp, pair, direction, outcome, strategy, r_multiple, ...} ]}` where `r_multiple` may legitimately be null.

**Python command used throughout** (the worktree has no venv, so use the main checkout's interpreter from inside the worktree):

```bash
PY="C:/Users/irons/dev/automated-forex-strategy/venv/Scripts/python.exe"
```

---

## File structure

- Create `src/agents/copilot/__init__.py` (empty)
- Create `src/agents/copilot/models.py` — check dict builder, status ordering, `worst`, `safe_check`
- Create `src/agents/copilot/market_calendar.py` — `parse_ts`, `is_market_open`, `trading_days_since`
- Create `src/agents/copilot/checks_outcome.py` — the three checks and `live_strategy_ids`
- Create `src/agents/copilot/alerting.py` — alert planner, heartbeat, maintenance flag, boot grace
- Create `src/agents/copilot/runner.py` — config loading, `run_once`, delivery, dead-man ping
- Create `src/agents/copilot/endpoint.py` — payload fallback, Flask blueprint, guarded registration
- Create `scripts/copilot_watchdog.py` — entry point
- Create `config/copilot_checks.json` — thresholds
- Create `deploy/forex-copilot-watchdog.service`, `deploy/forex-copilot-watchdog.timer`
- Modify `scripts/status_server.py` — one guarded registration block after `app = Flask(__name__)`
- Create tests under `tests/agents/copilot/` (one file per module, plus `test_deploy_units.py`, `test_status_server_routes.py`, `test_runner.py`)

---

### Task 0: Worktree and baseline

**Files:** none created in the repo.

- [ ] **Step 1: Create the worktree from origin/main**

```bash
cd C:/Users/irons/dev/automated-forex-strategy
git fetch origin
git worktree add ../automated-forex-strategy-copilot -b feature/copilot-watchdog origin/main
cd ../automated-forex-strategy-copilot
git status -sb
```

Expected: `## feature/copilot-watchdog` and no modified files.

- [ ] **Step 2: Capture the baseline test result**

```bash
PY="C:/Users/irons/dev/automated-forex-strategy/venv/Scripts/python.exe"
"$PY" -m pytest tests/agents -q -m "not slow" -p no:cacheprovider 2>&1 | tail -n 5
```

Expected: about 471 passed (verified on origin/main). Do NOT run pytest over all of `tests/`: collecting it fails with a pandas environment error unrelated to this work. Record the numbers in your report as the baseline. If the baseline already has failures, list them; do not fix them.

---

### Task 1: Check model

**Files:**
- Create: `src/agents/copilot/__init__.py`
- Create: `src/agents/copilot/models.py`
- Create: `tests/agents/copilot/__init__.py`
- Test: `tests/agents/copilot/test_models.py`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/copilot/__init__.py` (empty) and `tests/agents/copilot/test_models.py`:

```python
import pytest

from src.agents.copilot.models import make_check, safe_check, unknown_check, worst


def test_make_check_rejects_bad_status():
    with pytest.raises(ValueError):
        make_check("x", "fine", "e", "t")


def test_make_check_shape_and_truncation():
    c = make_check("x", "ok", "e" * 500, "t")
    assert set(c) == {"id", "status", "severity", "evidence", "threshold", "since"}
    assert len(c["evidence"]) == 200
    assert c["since"] is None and c["severity"] == "crit"


def test_worst_orders_unknown_above_ok_and_below_warn():
    assert worst(["ok", "unknown"]) == "unknown"
    assert worst(["ok", "unknown", "warn"]) == "warn"
    assert worst(["warn", "crit", "ok"]) == "crit"
    assert worst(["ok", "ok"]) == "ok"
    assert worst([]) == "unknown"


def test_unknown_check_is_status_unknown():
    c = unknown_check("x", "why", "thr")
    assert c["status"] == "unknown" and c["evidence"] == "why" and c["threshold"] == "thr"


def test_safe_check_converts_exceptions_to_unknown_without_leaking_message():
    def boom():
        raise KeyError("secret-value")

    c = safe_check("x", "thr", boom)
    assert c["status"] == "unknown"
    assert "KeyError" in c["evidence"]
    assert "secret-value" not in c["evidence"]


def test_safe_check_passes_through_normal_results():
    assert safe_check("x", "t", lambda a, b: make_check("x", "ok", f"{a}{b}", "t"), 1, 2)["evidence"] == "12"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
"$PY" -m pytest tests/agents/copilot/test_models.py -v -p no:cacheprovider
```

Expected: FAIL with `ModuleNotFoundError: No module named 'src.agents.copilot'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/copilot/__init__.py` (empty) and `src/agents/copilot/models.py`:

```python
"""Check result model and aggregation for the copilot watchdog."""
from __future__ import annotations

# Ordered worst-last. unknown ranks above ok so an unevaluable check can never
# read as healthy, and below warn/crit so it never hides a real problem.
STATUSES = ("ok", "unknown", "warn", "crit")
_RANK = {s: i for i, s in enumerate(STATUSES)}
_EVIDENCE_MAX = 200


def make_check(check_id, status, evidence, threshold, since=None, severity="crit"):
    if status not in _RANK:
        raise ValueError(f"bad status {status!r}")
    return {
        "id": check_id,
        "status": status,
        "severity": severity,
        "evidence": str(evidence)[:_EVIDENCE_MAX],
        "threshold": str(threshold),
        "since": since,
    }


def unknown_check(check_id, reason, threshold="", severity="crit"):
    return make_check(check_id, "unknown", reason, threshold, severity=severity)


def worst(statuses):
    statuses = list(statuses)
    if not statuses:
        return "unknown"
    return max(statuses, key=lambda s: _RANK[s])


def safe_check(check_id, threshold, fn, *args, **kwargs):
    """Run a check; any exception becomes an unknown result (class name only)."""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # one broken check must not take down the run
        return unknown_check(check_id, f"check raised {type(exc).__name__}", threshold)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
"$PY" -m pytest tests/agents/copilot/test_models.py -v -p no:cacheprovider
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agents/copilot tests/agents/copilot
git commit -m "feat(copilot): check model with unknown-safe aggregation"
```

---

### Task 2: Market calendar and timestamp parsing

**Files:**
- Create: `src/agents/copilot/market_calendar.py`
- Test: `tests/agents/copilot/test_market_calendar.py`

- [ ] **Step 1: Write the failing test**

```python
from datetime import datetime, timezone

import pytest

from src.agents.copilot.market_calendar import is_market_open, parse_ts, trading_days_since


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "when,expected",
    [
        (utc(2026, 9, 18, 20, 59), True),   # Friday just before close
        (utc(2026, 9, 18, 21, 0), False),   # Friday close
        (utc(2026, 9, 19, 12, 0), False),   # Saturday
        (utc(2026, 9, 20, 20, 59), False),  # Sunday before reopen
        (utc(2026, 9, 20, 21, 0), True),    # Sunday reopen
        (utc(2026, 9, 21, 10, 0), True),    # Monday
        (utc(2026, 12, 25, 12, 0), False),  # Christmas
        (utc(2027, 1, 1, 12, 0), False),    # New Year
    ],
)
def test_is_market_open(when, expected):
    assert is_market_open(when) is expected


def test_trading_days_friday_to_monday_counts_only_monday():
    assert trading_days_since(utc(2026, 9, 18, 14, 0), utc(2026, 9, 21, 10, 0)) == 1


def test_trading_days_one_week():
    assert trading_days_since(utc(2026, 9, 14, 10, 0), utc(2026, 9, 21, 10, 0)) == 5


def test_trading_days_weekend_does_not_age():
    assert trading_days_since(utc(2026, 9, 18, 14, 0), utc(2026, 9, 20, 12, 0)) == 0


def test_trading_days_skips_holidays():
    assert trading_days_since(utc(2026, 12, 24, 10, 0), utc(2026, 12, 28, 10, 0)) == 1


def test_trading_days_never_negative():
    assert trading_days_since(utc(2026, 9, 21, 10, 0), utc(2026, 9, 18, 10, 0)) == 0


@pytest.mark.parametrize(
    "value",
    ["2026-09-18T14:00:00+00:00", "2026-09-18T14:00:00Z", "2026-09-18T14:00:00", "2026-09-18T16:00:00+02:00"],
)
def test_parse_ts_accepts_iso_and_normalises_to_utc(value):
    assert parse_ts(value) == utc(2026, 9, 18, 14, 0)


@pytest.mark.parametrize("value", [None, "", "garbage", 12345, "2026-13-45T00:00:00Z"])
def test_parse_ts_rejects_garbage(value):
    assert parse_ts(value) is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
"$PY" -m pytest tests/agents/copilot/test_market_calendar.py -v -p no:cacheprovider
```

Expected: FAIL, `ModuleNotFoundError` for `market_calendar`.

- [ ] **Step 3: Write minimal implementation**

```python
"""UTC forex market calendar and timestamp parsing for the copilot watchdog.

The forex week closes Friday 21:00 UTC and reopens Sunday 21:00 UTC. Christmas
Day and New Year's Day are treated as closed for the whole UTC day. Everything
is UTC; there is no daylight-saving handling by design.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

_HOLIDAYS = ((12, 25), (1, 1))


def _utc(dt):
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _is_holiday(d):
    return (d.month, d.day) in _HOLIDAYS


def parse_ts(value):
    """Parse an ISO-8601 string to an aware UTC datetime, or None."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return _utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def is_market_open(now):
    now = _utc(now)
    if _is_holiday(now):
        return False
    weekday = now.weekday()  # Monday is 0
    if weekday == 5:
        return False
    if weekday == 4 and now.hour >= 21:
        return False
    if weekday == 6 and now.hour < 21:
        return False
    return True


def trading_days_since(then, now):
    """Mon-Fri UTC dates strictly after `then`'s date up to and including
    `now`'s date, excluding holidays. Today counts even though it is partial."""
    then, now = _utc(then), _utc(now)
    if now <= then:
        return 0
    day = then.date() + timedelta(days=1)
    count = 0
    while day <= now.date():
        if day.weekday() < 5 and not _is_holiday(day):
            count += 1
        day += timedelta(days=1)
    return count
```

- [ ] **Step 4: Run test to verify it passes**

```bash
"$PY" -m pytest tests/agents/copilot/test_market_calendar.py -v -p no:cacheprovider
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/agents/copilot/market_calendar.py tests/agents/copilot/test_market_calendar.py
git commit -m "feat(copilot): UTC market calendar and timestamp parsing"
```

---

### Task 3: Outcome checks

**Files:**
- Create: `src/agents/copilot/checks_outcome.py`
- Test: `tests/agents/copilot/test_checks_outcome.py`

- [ ] **Step 1: Write the failing test**

```python
from datetime import datetime, timezone

import pytest

from src.agents.copilot.checks_outcome import (
    check_live_trades_schema,
    check_sizing_pinned_zero,
    check_trade_velocity,
    live_strategy_ids,
)

NOW = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)
LIVE = {"a", "b"}
OK = {"size_multiplier": 1.0, "entry_permitted": True}
ZERO = {"size_multiplier": 0.0, "entry_permitted": True}


def state(updated, **entries):
    return {"updated_at": updated, "strategies": entries, "global": {}}


# ---- live_strategy_ids ----
def test_live_ids_use_live_flag_or_status():
    reg = {"a": {"live": True}, "b": {"status": "live"}, "c": {"state": "gate"}, "d": "junk"}
    assert live_strategy_ids(reg) == {"a", "b"}


@pytest.mark.parametrize("bad", [None, {}, [], "x"])
def test_live_ids_unreadable_registry_is_none(bad):
    assert live_strategy_ids(bad) is None


# ---- sizing_pinned_zero ----
def test_all_sized_ok_and_counts_reset():
    chk, new = check_sizing_pinned_zero(state("t1", a=OK, b=OK), LIVE, {})
    assert chk["status"] == "ok" and new["counts"] == {"a": 0, "b": 0}


def test_zero_once_warns_twice_is_crit():
    chk, p = check_sizing_pinned_zero(state("t1", a=ZERO, b=OK), LIVE, {})
    assert chk["status"] == "warn" and p["counts"]["a"] == 1
    chk, p = check_sizing_pinned_zero(state("t2", a=ZERO, b=OK), LIVE, p)
    assert chk["status"] == "crit" and "a" in chk["evidence"] and p["counts"]["a"] == 2


def test_same_execution_run_is_not_double_counted():
    _, p = check_sizing_pinned_zero(state("t1", a=ZERO, b=OK), LIVE, {})
    chk, p2 = check_sizing_pinned_zero(state("t1", a=ZERO, b=OK), LIVE, p)
    assert p2["counts"]["a"] == 1 and chk["status"] == "warn"


def test_recovery_resets_count():
    _, p = check_sizing_pinned_zero(state("t1", a=ZERO, b=OK), LIVE, {})
    chk, p = check_sizing_pinned_zero(state("t2", a=OK, b=OK), LIVE, p)
    assert chk["status"] == "ok" and p["counts"]["a"] == 0


def test_entry_not_permitted_alone_is_not_pinned():
    # entry_permitted is False in normal states too (emergency halt, portfolio R cap,
    # correlated-group cap). Only a size of zero is the bootstrap-deadlock signature.
    blocked = {"size_multiplier": 1.0, "entry_permitted": False}
    chk, new = check_sizing_pinned_zero(state("t1", a=blocked, b=OK), LIVE, {})
    assert chk["status"] == "ok" and new["counts"]["a"] == 0


def test_stale_execution_state_is_unknown_when_now_is_given():
    stale = state("2026-08-01T00:00:00+00:00", a=OK, b=OK)
    chk, new = check_sizing_pinned_zero(stale, LIVE, {"last_updated_at": "x", "counts": {"a": 1}}, now=NOW)
    assert chk["status"] == "unknown" and "stale" in chk["evidence"] and new["counts"] == {"a": 1}


def test_recent_execution_state_is_evaluated_when_now_is_given():
    fresh = state("2026-09-21T06:00:00+00:00", a=OK, b=OK)
    assert check_sizing_pinned_zero(fresh, LIVE, {}, now=NOW)[0]["status"] == "ok"


def test_unparseable_updated_at_is_unknown_when_now_is_given():
    assert check_sizing_pinned_zero(state("garbage", a=OK, b=OK), LIVE, {}, now=NOW)[0]["status"] == "unknown"


def test_missing_size_counts_as_pinned():
    chk, _ = check_sizing_pinned_zero(state("t1", a={"entry_permitted": True}, b=OK), LIVE, {})
    assert chk["status"] == "warn"


def test_strategy_missing_from_state_is_not_counted_here():
    chk, _ = check_sizing_pinned_zero(state("t1", a=OK), LIVE, {})
    assert chk["status"] == "ok"


def test_no_live_strategy_present_is_unknown():
    chk, _ = check_sizing_pinned_zero(state("t1"), LIVE, {})
    assert chk["status"] == "unknown"


@pytest.mark.parametrize(
    "bad",
    [None, {}, {"updated_at": "t", "strategies": []}, {"strategies": {}}, {"updated_at": "", "strategies": {}}],
)
def test_malformed_execution_state_is_unknown_and_keeps_previous_counts(bad):
    prev = {"last_updated_at": "t0", "counts": {"a": 1}}
    chk, new = check_sizing_pinned_zero(bad, LIVE, prev)
    assert chk["status"] == "unknown" and new["counts"] == {"a": 1}


def test_unreadable_registry_is_unknown():
    chk, _ = check_sizing_pinned_zero(state("t1", a=OK), None, {})
    assert chk["status"] == "unknown"


def test_no_live_strategies_is_ok():
    chk, new = check_sizing_pinned_zero(state("t1"), set(), {"counts": {"a": 3}})
    assert chk["status"] == "ok" and new["counts"] == {}


def test_counts_for_retired_strategies_are_dropped():
    _, p = check_sizing_pinned_zero(state("t1", a=ZERO, b=OK), LIVE, {"counts": {"gone": 5}})
    assert "gone" not in p["counts"]


# ---- trade_velocity ----
def doc(*stamps):
    return {"trades": [{"timestamp": s, "pair": "EURUSD"} for s in stamps]}


def test_recent_trade_ok():
    assert check_trade_velocity(doc("2026-09-18T14:00:00+00:00"), 10, NOW)["status"] == "ok"


def test_warn_at_five_trading_days():
    chk = check_trade_velocity(doc("2026-09-14T10:00:00+00:00"), 10, NOW)
    assert chk["status"] == "warn" and "5 trading days" in chk["evidence"]


def test_crit_at_ten_trading_days():
    assert check_trade_velocity(doc("2026-09-07T10:00:00+00:00"), 10, NOW)["status"] == "crit"


def test_uses_latest_of_many_and_z_suffix():
    chk = check_trade_velocity(doc("2026-08-01T00:00:00Z", "2026-09-18T14:00:00Z"), 10, NOW)
    assert chk["status"] == "ok"


def test_weekend_does_not_age_a_friday_trade():
    sunday = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    assert check_trade_velocity(doc("2026-09-18T14:00:00+00:00"), 10, sunday)["status"] == "ok"


def test_no_live_strategies_is_ok_even_without_trades():
    assert check_trade_velocity({"trades": []}, 0, NOW)["status"] == "ok"


def test_unreadable_registry_is_unknown():
    assert check_trade_velocity(doc("2026-09-18T14:00:00Z"), None, NOW)["status"] == "unknown"


@pytest.mark.parametrize("bad", [None, {}, {"trades": "x"}, {"trades": []}, doc("garbage")])
def test_missing_or_unparseable_trades_are_unknown(bad):
    assert check_trade_velocity(bad, 10, NOW)["status"] == "unknown"


def test_custom_thresholds():
    chk = check_trade_velocity(doc("2026-09-18T14:00:00Z"), 10, NOW, warn_days=1, crit_days=3)
    assert chk["status"] == "warn"


# ---- live_trades_schema ----
GOOD = {
    "timestamp": "2026-09-18T14:00:00+00:00",
    "pair": "EURUSD",
    "direction": "LONG",
    "outcome": "win",
    "strategy": "inside_bar",
    "r_multiple": None,
}


def test_valid_records_ok_even_with_null_r_multiple():
    assert check_live_trades_schema({"trades": [GOOD, GOOD]})["status"] == "ok"


def test_empty_trades_ok():
    assert check_live_trades_schema({"trades": []})["status"] == "ok"


def test_missing_key_warns_and_names_first_index():
    bad = dict(GOOD)
    del bad["outcome"]
    chk = check_live_trades_schema({"trades": [GOOD, bad]})
    assert chk["status"] == "warn" and "1 of 2" in chk["evidence"] and "index 1" in chk["evidence"]


def test_non_dict_and_bad_timestamp_records_are_malformed():
    chk = check_live_trades_schema({"trades": ["x", {**GOOD, "timestamp": "nope"}]})
    assert chk["status"] == "warn" and "2 of 2" in chk["evidence"]


@pytest.mark.parametrize("bad", [None, {}, {"trades": None}, []])
def test_unreadable_document_is_unknown(bad):
    assert check_live_trades_schema(bad)["status"] == "unknown"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
"$PY" -m pytest tests/agents/copilot/test_checks_outcome.py -v -p no:cacheprovider
```

Expected: FAIL, `ModuleNotFoundError` for `checks_outcome`.

- [ ] **Step 3: Write minimal implementation**

```python
"""Outcome-level health checks. Pure functions: inputs in, check dicts out.

Every check reports `unknown`, never `ok`, when its input is missing or
malformed. Process-level liveness is deliberately not here; the bot's own
agents already cover it and Plan A-2 adds meta-checks for them.
"""
from __future__ import annotations

from src.agents.copilot.market_calendar import parse_ts, trading_days_since
from src.agents.copilot.models import make_check, unknown_check

REQUIRED_TRADE_KEYS = ("timestamp", "pair", "direction", "outcome", "strategy")


def live_strategy_ids(registry):
    """Ids the bot treats as live (same rule as the execution agent), or None
    when the registry is unreadable or empty."""
    if not isinstance(registry, dict) or not registry:
        return None
    return {
        sid
        for sid, cfg in registry.items()
        if isinstance(cfg, dict) and (cfg.get("live") or cfg.get("status") == "live")
    }


EXEC_STATE_MAX_AGE_S = 9 * 3600  # the execution timer runs every 4 hours; allow two missed runs


def _is_pinned(entry):
    """Size-only on purpose. `entry_permitted` is False in legitimate states
    (emergency halt, portfolio R cap, correlated-group cap), so treating it as
    pinned would false-alarm; blocked-entry reasons are Plan A-2 territory."""
    size = entry.get("size_multiplier")
    return not isinstance(size, (int, float)) or isinstance(size, bool) or size <= 0


def check_sizing_pinned_zero(exec_state, live_ids, prev, max_runs=2, now=None):
    """Flag live strategies sized at zero for `max_runs`+ consecutive execution
    runs (the bootstrap-deadlock failure class, which produced no errors
    anywhere). If `now` is given, an execution_state older than
    EXEC_STATE_MAX_AGE_S is `unknown` (a dead execution agent would otherwise
    freeze the file and read as healthy). Returns (check, new_prev)."""
    cid = "sizing_pinned_zero"
    threshold = f"size 0 for {max_runs}+ consecutive execution runs"
    prev = prev if isinstance(prev, dict) else {}
    last = prev.get("last_updated_at")
    counts = dict(prev.get("counts") or {})
    keep = {"last_updated_at": last, "counts": counts}

    if live_ids is None:
        return unknown_check(cid, "strategy registry unreadable", threshold), keep
    if (
        not isinstance(exec_state, dict)
        or not isinstance(exec_state.get("strategies"), dict)
        or not isinstance(exec_state.get("updated_at"), str)
        or not exec_state["updated_at"]
    ):
        return unknown_check(cid, "execution_state missing or malformed", threshold), keep

    updated = exec_state["updated_at"]
    if now is not None:
        ts = parse_ts(updated)
        if ts is None or (now - ts).total_seconds() > EXEC_STATE_MAX_AGE_S:
            return unknown_check(cid, "execution_state stale or undated", threshold), keep
    if not live_ids:
        return make_check(cid, "ok", "no live strategies", threshold), {"last_updated_at": updated, "counts": {}}

    strategies = exec_state["strategies"]
    present = [s for s in sorted(live_ids) if isinstance(strategies.get(s), dict)]
    if not present:
        return unknown_check(cid, "no live strategy present in execution_state", threshold), keep

    new_run = updated != last
    pinned = []
    for sid in present:
        is_pin = _is_pinned(strategies[sid])
        if is_pin:
            pinned.append(sid)
        if new_run:
            counts[sid] = (counts.get(sid, 0) + 1) if is_pin else 0
    counts = {s: c for s, c in counts.items() if s in live_ids}
    new_prev = {"last_updated_at": updated, "counts": counts}

    stuck = [s for s in pinned if counts.get(s, 0) >= max_runs]
    if stuck:
        return make_check(cid, "crit", f"sized at zero: {', '.join(stuck)}", threshold), new_prev
    if pinned:
        return make_check(cid, "warn", f"sized at zero this run: {', '.join(pinned)}", threshold), new_prev
    return make_check(cid, "ok", f"{len(present)} live strategies sized above zero", threshold), new_prev


def check_trade_velocity(trades_doc, live_count, now, warn_days=5, crit_days=10):
    """Book-wide age of the newest trade record in trading days (market-aware:
    weekends and holidays do not age it). Per-strategy cadence is Plan A-2."""
    cid = "trade_velocity"
    threshold = f"warn {warn_days} / crit {crit_days} trading days without a trade (book-wide)"
    if live_count is None:
        return unknown_check(cid, "strategy registry unreadable", threshold)
    if live_count == 0:
        return make_check(cid, "ok", "no live strategies", threshold)
    trades = trades_doc.get("trades") if isinstance(trades_doc, dict) else None
    if not isinstance(trades, list):
        return unknown_check(cid, "live_trades missing or malformed", threshold)
    stamps = [parse_ts(t.get("timestamp")) for t in trades if isinstance(t, dict)]
    stamps = [s for s in stamps if s is not None]
    if not stamps:
        return unknown_check(cid, "no parseable trade timestamps", threshold)
    last = max(stamps)
    days = trading_days_since(last, now)
    evidence = f"last trade record {last.strftime('%Y-%m-%d %H:%MZ')}, {days} trading days ago"
    if days >= crit_days:
        return make_check(cid, "crit", evidence, threshold)
    if days >= warn_days:
        return make_check(cid, "warn", evidence, threshold)
    return make_check(cid, "ok", evidence, threshold)


def check_live_trades_schema(trades_doc):
    """Schema check, not value check: r_multiple may legitimately be null."""
    cid = "live_trades_schema"
    threshold = f"every record has {', '.join(REQUIRED_TRADE_KEYS)} and a parseable timestamp"
    trades = trades_doc.get("trades") if isinstance(trades_doc, dict) else None
    if not isinstance(trades, list):
        return unknown_check(cid, "live_trades missing or malformed", threshold, severity="warn")
    bad = [
        i
        for i, t in enumerate(trades)
        if not isinstance(t, dict)
        or any(k not in t for k in REQUIRED_TRADE_KEYS)
        or parse_ts(t.get("timestamp")) is None
    ]
    if bad:
        return make_check(
            cid, "warn", f"{len(bad)} of {len(trades)} records malformed, first at index {bad[0]}", threshold, severity="warn"
        )
    return make_check(cid, "ok", f"{len(trades)} records valid", threshold, severity="warn")
```

- [ ] **Step 4: Run test to verify it passes**

```bash
"$PY" -m pytest tests/agents/copilot/test_checks_outcome.py -v -p no:cacheprovider
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/agents/copilot/checks_outcome.py tests/agents/copilot/test_checks_outcome.py
git commit -m "feat(copilot): outcome checks (sizing pinned, trade velocity, trades schema)"
```

---

### Task 4: Alert planning, heartbeat, maintenance flag, boot grace

**Files:**
- Create: `src/agents/copilot/alerting.py`
- Test: `tests/agents/copilot/test_alerting.py`

- [ ] **Step 1: Write the failing test**

```python
import json
from datetime import datetime, timedelta, timezone

from src.agents.copilot.alerting import (
    DEFAULT_ALERT_CFG,
    boot_grace_active,
    format_heartbeat,
    heartbeat_due,
    maintenance_active,
    plan_alerts,
)
from src.agents.copilot.models import make_check

T0 = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)
CFG = dict(DEFAULT_ALERT_CFG)


def chk(cid, status, evidence="e"):
    return make_check(cid, status, evidence, "thr")


def test_warn_alerts_once_then_respects_cooldown():
    msgs, st = plan_alerts([chk("a", "warn", "boom")], {}, T0, CFG)
    assert len(msgs) == 1 and msgs[0]["kind"] == "alert" and msgs[0]["text"].startswith("[WATCHDOG] WARN a: boom")
    msgs, st = plan_alerts([chk("a", "warn")], st, T0 + timedelta(minutes=15), CFG)
    assert msgs == []
    msgs, st = plan_alerts([chk("a", "warn")], st, T0 + timedelta(minutes=361), CFG)
    assert len(msgs) == 1


def test_a_future_sent_at_does_not_silence_alerts():
    st = {"alerts": {"a": {"alerted_status": "warn", "sent_at": "2026-09-22T10:00:00Z", "unknown_runs": 0}}, "sent_log": []}
    msgs, _ = plan_alerts([chk("a", "warn")], st, T0, CFG)
    assert len(msgs) == 1


def test_escalation_warn_to_crit_alerts_immediately():
    _, st = plan_alerts([chk("a", "warn")], {}, T0, CFG)
    msgs, _ = plan_alerts([chk("a", "crit")], st, T0 + timedelta(minutes=15), CFG)
    assert len(msgs) == 1 and "CRIT" in msgs[0]["text"]


def test_recovery_sent_once():
    _, st = plan_alerts([chk("a", "crit")], {}, T0, CFG)
    msgs, st = plan_alerts([chk("a", "ok")], st, T0 + timedelta(minutes=15), CFG)
    assert len(msgs) == 1 and msgs[0]["kind"] == "recovery"
    msgs, _ = plan_alerts([chk("a", "ok")], st, T0 + timedelta(minutes=30), CFG)
    assert msgs == []


def test_ok_that_never_alerted_is_silent():
    msgs, _ = plan_alerts([chk("a", "ok")], {}, T0, CFG)
    assert msgs == []


def test_unknown_alerts_only_after_grace_runs():
    st = {}
    for i in range(CFG["unknown_grace_runs"] - 1):
        msgs, st = plan_alerts([chk("a", "unknown")], st, T0 + timedelta(minutes=15 * i), CFG)
        assert msgs == []
    msgs, st = plan_alerts([chk("a", "unknown")], st, T0 + timedelta(minutes=60), CFG)
    assert len(msgs) == 1 and "UNKNOWN" in msgs[0]["text"]


def test_unknown_streak_resets_on_ok():
    st = {}
    for i in range(2):
        _, st = plan_alerts([chk("a", "unknown")], st, T0 + timedelta(minutes=15 * i), CFG)
    _, st = plan_alerts([chk("a", "ok")], st, T0 + timedelta(minutes=30), CFG)
    msgs, _ = plan_alerts([chk("a", "unknown")], st, T0 + timedelta(minutes=45), CFG)
    assert msgs == []


def test_global_hourly_cap_defers_and_retries_next_run():
    checks = [chk(f"c{i}", "crit") for i in range(8)]
    msgs, st = plan_alerts(checks, {}, T0, CFG)
    assert len(msgs) == CFG["max_per_hour"]
    msgs2, _ = plan_alerts(checks, st, T0 + timedelta(minutes=61), CFG)
    assert {m["id"] for m in msgs2} >= {"c5", "c6", "c7"}


def test_suppressed_sends_nothing_and_alerts_fire_after():
    msgs, st = plan_alerts([chk("a", "crit")], {}, T0, CFG, suppressed=True)
    assert msgs == []
    msgs, _ = plan_alerts([chk("a", "crit")], st, T0 + timedelta(minutes=15), CFG)
    assert len(msgs) == 1


def test_suppressed_defers_recovery_too():
    _, st = plan_alerts([chk("a", "crit")], {}, T0, CFG)
    msgs, st = plan_alerts([chk("a", "ok")], st, T0 + timedelta(minutes=15), CFG, suppressed=True)
    assert msgs == []
    msgs, _ = plan_alerts([chk("a", "ok")], st, T0 + timedelta(minutes=30), CFG)
    assert msgs and msgs[0]["kind"] == "recovery"


def test_text_is_html_escaped():
    msgs, _ = plan_alerts([chk("a", "warn", "<b>x</b> & y")], {}, T0, CFG)
    assert "<b>" not in msgs[0]["text"] and "&lt;b&gt;" in msgs[0]["text"] and "&amp;" in msgs[0]["text"]


def test_state_is_json_serialisable_and_survives_garbage_input():
    _, st = plan_alerts([chk("a", "warn")], {"alerts": "junk", "sent_log": [1, None]}, T0, CFG)
    json.dumps(st)


# ---- heartbeat ----
def test_heartbeat_due_rules():
    assert heartbeat_due({}, datetime(2026, 9, 21, 7, 0, tzinfo=timezone.utc), 7) is True
    assert heartbeat_due({}, datetime(2026, 9, 21, 6, 59, tzinfo=timezone.utc), 7) is False
    assert heartbeat_due({"last_heartbeat": "2026-09-21T07:00:00Z"}, datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc), 7) is False
    assert heartbeat_due({"last_heartbeat": "2026-09-20T07:00:00Z"}, datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc), 7) is True
    assert heartbeat_due({"last_heartbeat": "garbage"}, datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc), 7) is True


def test_format_heartbeat_reports_positive_facts():
    payload = {
        "overall": "ok",
        "headline": {"live_strategies": 10, "last_trade_trading_days": 1},
        "checks": [{"status": "ok"}, {"status": "ok"}, {"status": "warn"}],
    }
    text = format_heartbeat(payload)
    assert text.startswith("[WATCHDOG] daily heartbeat: overall ok.")
    assert "10 live strategies" in text and "1 trading days" in text and "2 ok, 1 warn, 0 crit, 0 unknown" in text


# ---- maintenance flag and boot grace ----
def test_maintenance_active_only_until_expiry(tmp_path):
    flag = tmp_path / "copilot_maintenance"
    assert maintenance_active(flag, T0) is False
    flag.write_text("2026-09-21T11:00:00Z")
    assert maintenance_active(flag, T0) is True
    assert maintenance_active(flag, T0 + timedelta(hours=2)) is False


def test_maintenance_flag_without_valid_expiry_never_silences(tmp_path):
    flag = tmp_path / "copilot_maintenance"
    flag.write_text("forever")
    assert maintenance_active(flag, T0) is False


def test_boot_grace():
    assert boot_grace_active(120) is True
    assert boot_grace_active(601) is False
    assert boot_grace_active(None) is False
```

- [ ] **Step 2: Run test to verify it fails**

```bash
"$PY" -m pytest tests/agents/copilot/test_alerting.py -v -p no:cacheprovider
```

Expected: FAIL, `ModuleNotFoundError` for `alerting`.

- [ ] **Step 3: Write minimal implementation**

```python
"""Alert planning for the copilot watchdog. Pure functions plus two tiny
file/uptime guards. Alert text is code-templated only: it never quotes log
lines or free text from other systems."""
from __future__ import annotations

import html
from datetime import datetime, timedelta
from pathlib import Path

from src.agents.copilot.market_calendar import parse_ts
from src.agents.copilot.models import STATUSES

DEFAULT_ALERT_CFG = {
    "cooldown_min": 360,
    "max_per_hour": 5,
    "unknown_grace_runs": 3,
    "heartbeat_hour_utc": 7,
}
_RANK = {s: i for i, s in enumerate(STATUSES)}


def _z(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _fmt_alert(check) -> str:
    return f"[WATCHDOG] {check['status'].upper()} {html.escape(check['id'])}: {html.escape(check['evidence'])}"


def _fmt_recovery(check) -> str:
    return f"[WATCHDOG] recovered: {html.escape(check['id'])} is ok again ({html.escape(check['evidence'])})"


def plan_alerts(checks, state, now, cfg, suppressed=False):
    """Decide which messages to send. Returns (messages, new_state).

    Dedup: one alert per check until the cooldown passes or it escalates.
    Recovery: sent once when a previously alerted check returns to ok.
    Cap: at most cfg['max_per_hour'] alerts an hour across all checks; alerts
    over the cap stay pending and are retried on the next run.
    Suppressed (maintenance or boot grace): nothing is sent and nothing is
    marked as sent, so problems that persist alert as soon as it ends.
    """
    st = state if isinstance(state, dict) else {}
    raw_alerts = st.get("alerts") if isinstance(st.get("alerts"), dict) else {}
    raw_log = st.get("sent_log") if isinstance(st.get("sent_log"), list) else []
    alerts = {k: dict(v) for k, v in raw_alerts.items() if isinstance(v, dict)}
    window_start = now - timedelta(hours=1)
    sent_log = [t for t in raw_log if isinstance(t, str) and (p := parse_ts(t)) is not None and p > window_start]

    messages = []
    cooldown = timedelta(minutes=cfg["cooldown_min"])
    for c in checks:
        cid, status = c["id"], c["status"]
        rec = alerts.get(cid) or {"alerted_status": "ok", "sent_at": None, "unknown_runs": 0}
        rec["unknown_runs"] = (rec.get("unknown_runs", 0) + 1) if status == "unknown" else 0
        wants = status in ("warn", "crit") or (status == "unknown" and rec["unknown_runs"] >= cfg["unknown_grace_runs"])
        if wants:
            sent_at = parse_ts(rec.get("sent_at"))
            escalated = _RANK[status] > _RANK.get(rec.get("alerted_status", "ok"), 0)
            # A sent_at in the future (clock went backwards) must not silence alerts.
            due = sent_at is None or sent_at > now or escalated or (now - sent_at) >= cooldown
            if due and not suppressed and len(sent_log) < cfg["max_per_hour"]:
                messages.append({"kind": "alert", "id": cid, "text": _fmt_alert(c)})
                sent_log.append(_z(now))
                rec["sent_at"] = _z(now)
                rec["alerted_status"] = status
        elif status == "ok" and rec.get("alerted_status") in ("warn", "crit", "unknown") and not suppressed:
            messages.append({"kind": "recovery", "id": cid, "text": _fmt_recovery(c)})
            rec["alerted_status"] = "ok"
            rec["sent_at"] = None
        alerts[cid] = rec
    return messages, {"alerts": alerts, "sent_log": sent_log}


def heartbeat_due(state, now, hour_utc=7) -> bool:
    if now.hour < hour_utc:
        return False
    last = parse_ts(state.get("last_heartbeat")) if isinstance(state, dict) else None
    return last is None or last.date() < now.date()


def format_heartbeat(payload) -> str:
    """One positive-facts message a day, so silence is never read as health."""
    counts = {s: 0 for s in STATUSES}
    for c in payload.get("checks", []):
        if c.get("status") in counts:
            counts[c["status"]] += 1
    head = payload.get("headline", {}) or {}
    parts = [f"[WATCHDOG] daily heartbeat: overall {payload.get('overall', 'unknown')}."]
    if head.get("live_strategies") is not None:
        parts.append(f"{head['live_strategies']} live strategies.")
    if head.get("last_trade_trading_days") is not None:
        parts.append(f"Last trade record {head['last_trade_trading_days']} trading days ago.")
    parts.append(
        f"Checks: {counts['ok']} ok, {counts['warn']} warn, {counts['crit']} crit, {counts['unknown']} unknown."
    )
    return " ".join(parts)


def maintenance_active(path, now) -> bool:
    """True while the flag file holds a future ISO expiry. A missing, garbage or
    expired flag never silences alerts, so maintenance mode cannot be left on."""
    try:
        text = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return False
    expiry = parse_ts(text)
    return expiry is not None and expiry > now


def boot_grace_active(uptime_s, grace_s=600) -> bool:
    return isinstance(uptime_s, (int, float)) and not isinstance(uptime_s, bool) and uptime_s < grace_s
```

- [ ] **Step 4: Run test to verify it passes**

```bash
"$PY" -m pytest tests/agents/copilot/test_alerting.py -v -p no:cacheprovider
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/agents/copilot/alerting.py tests/agents/copilot/test_alerting.py
git commit -m "feat(copilot): alert planner with cooldown, cap, recovery, heartbeat, maintenance and boot grace"
```

---

### Task 5: Runner, config and entry script

**Files:**
- Create: `config/copilot_checks.json`
- Create: `src/agents/copilot/runner.py`
- Create: `scripts/copilot_watchdog.py`
- Test: `tests/agents/copilot/test_runner.py`

- [ ] **Step 1: Write the failing test**

```python
import json
from datetime import datetime, timedelta, timezone

from src.agents.copilot.runner import deadman_ping, load_config, run_once

NOW = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)


def seed(tmp_path, *, size=1.0, updated="2026-09-21T09:00:00+00:00", last_trade="2026-09-17T14:00:00+00:00"):
    (tmp_path / "config").mkdir(exist_ok=True)
    (tmp_path / "results").mkdir(exist_ok=True)
    (tmp_path / "config" / "strategy_registry.json").write_text(
        json.dumps({"a": {"live": True}, "b": {"status": "live"}, "c": {"state": "gate"}})
    )
    (tmp_path / "results" / "execution_state.json").write_text(
        json.dumps(
            {
                "updated_at": updated,
                "strategies": {
                    "a": {"size_multiplier": size, "entry_permitted": True},
                    "b": {"size_multiplier": 1.0, "entry_permitted": True},
                },
                "global": {},
            }
        )
    )
    (tmp_path / "results" / "live_trades.json").write_text(
        json.dumps(
            {
                "trades": [
                    {
                        "timestamp": last_trade,
                        "pair": "EURUSD",
                        "direction": "LONG",
                        "outcome": "win",
                        "strategy": "x",
                        "r_multiple": 1.0,
                    }
                ]
            }
        )
    )


def read(tmp_path, name):
    return json.loads((tmp_path / "results" / name).read_text())


def dryrun_lines(tmp_path):
    p = tmp_path / "results" / "copilot_alerts_dryrun.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def test_healthy_run_writes_payload_and_state(tmp_path):
    seed(tmp_path)
    payload = run_once(tmp_path, now=NOW)
    assert payload["schema_version"] == 1 and payload["overall"] == "ok"
    assert payload["generated_at"] == "2026-09-21T10:00:00Z" and payload["ttl_s"] == 1800
    assert payload["market"]["state"] == "open"
    assert payload["headline"] == {"live_strategies": 2, "last_trade_trading_days": 2}
    assert {c["id"] for c in payload["checks"]} == {"sizing_pinned_zero", "trade_velocity", "live_trades_schema"}
    assert read(tmp_path, "copilot.json") == payload
    assert read(tmp_path, "copilot_state.json")["schema"] == 1


def test_missing_inputs_are_all_unknown_and_never_crash(tmp_path):
    (tmp_path / "results").mkdir()
    payload = run_once(tmp_path, now=NOW)
    assert payload["overall"] == "unknown"
    assert all(c["status"] == "unknown" for c in payload["checks"])


def test_dry_run_records_would_be_alerts_and_never_sends(tmp_path):
    seed(tmp_path, size=0.0)
    sent = []
    run_once(tmp_path, now=NOW, send=lambda t, a: sent.append(t), dry_run=True)
    run_once(tmp_path, now=NOW + timedelta(minutes=15), send=lambda t, a: sent.append(t), dry_run=True,)
    assert sent == []
    kinds = [l["kind"] for l in dryrun_lines(tmp_path)]
    assert "alert" in kinds and "heartbeat" in kinds


def test_two_zero_runs_escalate_to_crit(tmp_path):
    seed(tmp_path, size=0.0, updated="2026-09-21T09:00:00+00:00")
    run_once(tmp_path, now=NOW)
    seed(tmp_path, size=0.0, updated="2026-09-21T09:15:00+00:00")
    payload = run_once(tmp_path, now=NOW + timedelta(minutes=15))
    sizing = next(c for c in payload["checks"] if c["id"] == "sizing_pinned_zero")
    assert sizing["status"] == "crit" and payload["overall"] == "crit"


def test_real_send_uses_watchdog_prefix(tmp_path):
    seed(tmp_path, size=0.0)
    sent = []
    run_once(tmp_path, now=NOW, send=lambda text, alert_type: sent.append((text, alert_type)), dry_run=False)
    assert sent and all(t.startswith("[WATCHDOG]") for t, _ in sent)
    assert {a for _, a in sent} <= {"watchdog_alert", "watchdog_heartbeat", "watchdog_recovery"}


def test_heartbeat_once_per_day(tmp_path):
    seed(tmp_path)
    sent = []
    send = lambda t, a: sent.append(a)
    run_once(tmp_path, now=NOW, send=send, dry_run=False)
    run_once(tmp_path, now=NOW + timedelta(minutes=15), send=send, dry_run=False)
    assert sent.count("watchdog_heartbeat") == 1


def test_cooldown_state_persists_across_runs(tmp_path):
    seed(tmp_path, size=0.0)
    sent = []
    send = lambda t, a: sent.append(a)
    run_once(tmp_path, now=NOW, send=send, dry_run=False)
    seed(tmp_path, size=0.0, updated="2026-09-21T09:15:00+00:00")
    run_once(tmp_path, now=NOW + timedelta(minutes=15), send=send, dry_run=False)
    seed(tmp_path, size=0.0, updated="2026-09-21T09:30:00+00:00")
    run_once(tmp_path, now=NOW + timedelta(minutes=30), send=send, dry_run=False)
    assert sent.count("watchdog_alert") == 2  # warn, then escalation to crit; no repeats after


def test_maintenance_flag_suppresses_delivery(tmp_path):
    seed(tmp_path, size=0.0)
    (tmp_path / "results" / "copilot_maintenance").write_text("2026-09-21T12:00:00Z")
    sent = []
    run_once(tmp_path, now=NOW, send=lambda t, a: sent.append(t), dry_run=False)
    assert sent == []


def test_boot_grace_suppresses_delivery(tmp_path):
    seed(tmp_path, size=0.0)
    sent = []
    run_once(tmp_path, now=NOW, send=lambda t, a: sent.append(t), dry_run=False, uptime_s=60)
    assert sent == []


def test_load_config_defaults_and_overrides(tmp_path):
    assert load_config(tmp_path / "missing.json")["trade_velocity"] == {"warn_days": 5, "crit_days": 10}
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"trade_velocity": {"warn_days": 2}, "ttl_s": 900}))
    cfg = load_config(p)
    assert cfg["trade_velocity"] == {"warn_days": 2, "crit_days": 10} and cfg["ttl_s"] == 900
    p.write_text("not json")
    assert load_config(p)["ttl_s"] == 1800


def test_corrupt_state_and_inputs_never_crash_the_run(tmp_path):
    seed(tmp_path)
    (tmp_path / "results" / "copilot_state.json").write_text("[1]")
    payload = run_once(tmp_path, now=NOW)
    assert payload["overall"] == "ok"
    (tmp_path / "results" / "execution_state.json").write_bytes(b"\xff\xfe\x00bad")
    payload = run_once(tmp_path, now=NOW + timedelta(minutes=15))
    assert next(c for c in payload["checks"] if c["id"] == "sizing_pinned_zero")["status"] == "unknown"


def test_stale_execution_state_is_unknown_via_the_runner(tmp_path):
    seed(tmp_path, updated="2026-08-01T00:00:00+00:00")
    payload = run_once(tmp_path, now=NOW)
    sizing = next(c for c in payload["checks"] if c["id"] == "sizing_pinned_zero")
    assert sizing["status"] == "unknown"


def test_switching_from_dry_run_to_live_does_not_inherit_dry_run_state(tmp_path):
    seed(tmp_path, size=0.0)
    run_once(tmp_path, now=NOW, dry_run=True)
    seed(tmp_path, size=0.0, updated="2026-09-21T09:15:00+00:00")
    sent = []
    run_once(tmp_path, now=NOW + timedelta(minutes=15), send=lambda t, a: sent.append(a), dry_run=False)
    assert "watchdog_alert" in sent and "watchdog_heartbeat" in sent


def test_failed_send_is_retried_next_run_and_not_recorded_as_sent(tmp_path):
    seed(tmp_path, size=0.0)
    run_once(tmp_path, now=NOW, send=lambda t, a: False, dry_run=False)
    state = read(tmp_path, "copilot_state.json")
    assert state["alerts"]["sizing_pinned_zero"]["sent_at"] is None
    assert state["last_heartbeat"] is None
    sent = []
    run_once(tmp_path, now=NOW + timedelta(minutes=15), send=lambda t, a: sent.append(a), dry_run=False)
    assert "watchdog_alert" in sent and "watchdog_heartbeat" in sent


def test_send_returning_none_counts_as_success(tmp_path):
    seed(tmp_path, size=0.0)
    run_once(tmp_path, now=NOW, send=lambda t, a: None, dry_run=False)
    assert read(tmp_path, "copilot_state.json")["alerts"]["sizing_pinned_zero"]["sent_at"] is not None


def test_dry_run_file_rotates_when_large(tmp_path):
    seed(tmp_path, size=0.0)
    (tmp_path / "results" / "copilot_alerts_dryrun.jsonl").write_text("x" * 1_100_000)
    run_once(tmp_path, now=NOW, dry_run=True)
    assert (tmp_path / "results" / "copilot_alerts_dryrun.jsonl.1").exists()
    assert (tmp_path / "results" / "copilot_alerts_dryrun.jsonl").stat().st_size < 10_000


def test_deadman_ping_never_raises_and_only_pings_when_configured():
    calls = []
    assert deadman_ping("", http_get=lambda u, timeout: calls.append(u)) is False and calls == []
    assert deadman_ping("https://example.test/ping", http_get=lambda u, timeout: calls.append(u)) is True
    assert calls == ["https://example.test/ping"]

    def boom(u, timeout):
        raise OSError("down")

    assert deadman_ping("https://example.test/ping", http_get=boom) is False
```

- [ ] **Step 2: Run test to verify it fails**

```bash
"$PY" -m pytest tests/agents/copilot/test_runner.py -v -p no:cacheprovider
```

Expected: FAIL, `ModuleNotFoundError` for `runner`.

- [ ] **Step 3: Write minimal implementation**

Create `config/copilot_checks.json`:

```json
{
  "schema_version": 1,
  "ttl_s": 1800,
  "sizing_pinned_zero": { "max_runs": 2 },
  "trade_velocity": { "warn_days": 5, "crit_days": 10 },
  "alerts": {
    "cooldown_min": 360,
    "max_per_hour": 5,
    "unknown_grace_runs": 3,
    "heartbeat_hour_utc": 7
  }
}
```

Create `src/agents/copilot/runner.py`:

```python
"""One watchdog run: read state files, evaluate checks, publish, maybe alert.

Read-only over the bot's state. It writes only results/copilot.json,
results/copilot_state.json and (in dry-run) results/copilot_alerts_dryrun.jsonl
(rotated at 1 MB). Dry-run is the default; real Telegram sends need
dry_run=False. Inputs are read with plain json, never atomic_read (which takes
a lock file and would crash on the read-only config/ tree).
"""
from __future__ import annotations

import copy
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from src.agents.copilot.alerting import (
    DEFAULT_ALERT_CFG,
    boot_grace_active,
    format_heartbeat,
    heartbeat_due,
    maintenance_active,
    plan_alerts,
)
from src.agents.copilot.checks_outcome import (
    check_live_trades_schema,
    check_sizing_pinned_zero,
    check_trade_velocity,
    live_strategy_ids,
)
from src.agents.copilot.market_calendar import is_market_open, parse_ts, trading_days_since
from src.agents.copilot.models import safe_check, unknown_check, worst
from src.agents.shared.state_reader import atomic_write

logger = logging.getLogger(__name__)
_DRYRUN_MAX_BYTES = 1_000_000

DEFAULT_CONFIG = {
    "schema_version": 1,
    "ttl_s": 1800,
    "sizing_pinned_zero": {"max_runs": 2},
    "trade_velocity": {"warn_days": 5, "crit_days": 10},
    "alerts": dict(DEFAULT_ALERT_CFG),
}


def _z(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path):
    """Plain read, never raises, dict-or-None. Deliberately NOT atomic_read:
    that takes a FileLock on `<path>.lock`, which cannot be created under the
    unit's read-only /root/forex tree (config/ is read-only) and would crash
    the run. Writers use os.replace, so a plain read never sees a torn file."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def load_config(path):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    try:
        user = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return cfg
    if not isinstance(user, dict):
        return cfg
    for key, val in user.items():
        if isinstance(val, dict) and isinstance(cfg.get(key), dict):
            cfg[key].update(val)
        elif key in cfg:
            cfg[key] = val
    return cfg


def _last_trade_days(trades_doc, now):
    trades = trades_doc.get("trades") if isinstance(trades_doc, dict) else None
    if not isinstance(trades, list):
        return None
    stamps = [parse_ts(t.get("timestamp")) for t in trades if isinstance(t, dict)]
    stamps = [s for s in stamps if s is not None]
    return trading_days_since(max(stamps), now) if stamps else None


def build_payload(checks, live_count, trades_doc, now, cfg):
    headline = {}
    if live_count is not None:
        headline["live_strategies"] = live_count
    age = _last_trade_days(trades_doc, now)
    if age is not None:
        headline["last_trade_trading_days"] = age
    return {
        "schema_version": 1,
        "generated_at": _z(now),
        "ttl_s": cfg["ttl_s"],
        "overall": worst(c["status"] for c in checks),
        "market": {"state": "open" if is_market_open(now) else "closed"},
        "headline": headline,
        "checks": checks,
    }


def _deliver(messages, results, send, dry_run, now):
    """Deliver or (dry-run) record messages. Returns the messages whose send
    reported failure (an explicit False). A send returning None counts as
    success. Dry-run never fails."""
    failed = []
    dryrun_path = results / "copilot_alerts_dryrun.jsonl"
    if dry_run and dryrun_path.exists() and dryrun_path.stat().st_size > _DRYRUN_MAX_BYTES:
        os.replace(dryrun_path, dryrun_path.with_suffix(".jsonl.1"))
    for msg in messages:
        if dry_run:
            line = {"at": _z(now), "kind": msg["kind"], "id": msg["id"], "text": msg["text"]}
            with open(dryrun_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(line) + "\n")
        elif send(msg["text"], f"watchdog_{msg['kind']}") is False:
            failed.append(msg)
    return failed


def _default_send(results):
    """Send through the bot's existing notifier. send_telegram never raises and
    returns None, so wrap the HTTP post to learn whether it really succeeded."""
    import requests

    from src.agents.shared.telegram_notifier import send_telegram

    log_path = results / "telegram_log.jsonl"

    def send(text, alert_type):
        ok = [False]

        def post(*args, **kwargs):
            resp = requests.post(*args, **kwargs)
            ok[0] = resp.status_code == 200
            return resp

        send_telegram(text, alert_type, log_path, _http_post=post)
        return ok[0]

    return send


def _revert_failed(new_state, prior_state, failed, prior_heartbeat):
    """A message that failed to send must not start a cooldown or count as the
    day's heartbeat; restore the prior bookkeeping so the next run retries it."""
    prior_alerts = prior_state.get("alerts") if isinstance(prior_state.get("alerts"), dict) else {}
    for msg in failed:
        if msg["kind"] == "heartbeat":
            new_state["last_heartbeat"] = prior_heartbeat
        else:
            rec = new_state["alerts"].get(msg["id"])
            prior = prior_alerts.get(msg["id"]) if isinstance(prior_alerts.get(msg["id"]), dict) else {}
            if rec is not None:
                rec["sent_at"] = prior.get("sent_at")
                rec["alerted_status"] = prior.get("alerted_status", "ok")


def run_once(base_dir, now=None, send=None, dry_run=True, uptime_s=None):
    base = Path(base_dir)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    results = base / "results"
    cfg = load_config(base / "config" / "copilot_checks.json")

    registry = _read_json(base / "config" / "strategy_registry.json")
    exec_state = _read_json(results / "execution_state.json")
    trades_doc = _read_json(results / "live_trades.json")
    state = _read_json(results / "copilot_state.json") or {}
    # Dry-run bookkeeping (alerts marked sent, heartbeat stamped) must not leak
    # into live mode, or existing problems stay silent for a cooldown and the
    # first live heartbeat is skipped. Keep only the sizing counters.
    mode = "dry" if dry_run else "live"
    if state.get("mode") != mode:
        state = {"sizing": state.get("sizing")}
    live_ids = live_strategy_ids(registry)
    live_count = None if live_ids is None else len(live_ids)

    try:
        sizing, sizing_state = check_sizing_pinned_zero(
            exec_state, live_ids, state.get("sizing"), now=now, **cfg["sizing_pinned_zero"]
        )
    except Exception as exc:  # keep the previous counts; report unknown
        sizing = unknown_check("sizing_pinned_zero", f"check raised {type(exc).__name__}")
        sizing_state = state.get("sizing") or {}
    velocity = safe_check("trade_velocity", "", check_trade_velocity, trades_doc, live_count, now, **cfg["trade_velocity"])
    schema = safe_check("live_trades_schema", "", check_live_trades_schema, trades_doc)
    checks = [sizing, velocity, schema]

    payload = build_payload(checks, live_count, trades_doc, now, cfg)

    suppressed = maintenance_active(results / "copilot_maintenance", now) or boot_grace_active(uptime_s)
    messages, alert_state = plan_alerts(checks, state, now, cfg["alerts"], suppressed=suppressed)
    last_heartbeat = state.get("last_heartbeat")
    if not suppressed and heartbeat_due(state, now, cfg["alerts"]["heartbeat_hour_utc"]):
        messages.append({"kind": "heartbeat", "id": "heartbeat", "text": format_heartbeat(payload)})
        last_heartbeat = _z(now)

    new_state = {
        "schema": 1,
        "mode": mode,
        "sizing": sizing_state,
        "alerts": alert_state["alerts"],
        "sent_log": alert_state["sent_log"],
        "last_heartbeat": last_heartbeat,
        "last_run": _z(now),
    }

    # Deliver first, then persist, so a failed send is never recorded as sent.
    try:
        failed = _deliver(messages, results, send or _default_send(results), dry_run, now)
    except Exception as exc:  # delivery problems must not fail the run
        logger.warning("copilot delivery failed: %s", type(exc).__name__)
        failed = [m for m in messages]
    _revert_failed(new_state, state, failed, state.get("last_heartbeat"))

    atomic_write(results / "copilot.json", payload)
    atomic_write(results / "copilot_state.json", new_state)
    return payload


def real_uptime_s():
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def deadman_ping(url, http_get=None):
    """Optional external dead-man's-switch ping. Never raises. Returns True if pinged."""
    if not url:
        return False
    try:
        if http_get is None:
            import requests

            http_get = requests.get
        http_get(url, timeout=5)
        return True
    except Exception as exc:
        logger.warning("dead-man ping failed: %s", type(exc).__name__)
        return False
```

Create `scripts/copilot_watchdog.py`:

```python
#!/usr/bin/env python
"""Co-pilot watchdog entry point (run by forex-copilot-watchdog.timer).

Gated by WATCHDOG_ENABLED=1. Dry-run unless COPILOT_ALERTS=on. Optional
dead-man's-switch ping via COPILOT_DEADMAN_URL after a successful run.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    if os.environ.get("WATCHDOG_ENABLED") != "1":
        print("copilot watchdog disabled (set WATCHDOG_ENABLED=1)")
        return 0
    from src.agents.copilot.runner import deadman_ping, real_uptime_s, run_once

    dry_run = os.environ.get("COPILOT_ALERTS", "off") != "on"
    payload = run_once(ROOT, dry_run=dry_run, uptime_s=real_uptime_s())
    bad = [c["id"] for c in payload["checks"] if c["status"] != "ok"]
    print(f"copilot overall={payload['overall']} dry_run={dry_run} not_ok={bad}")
    deadman_ping(os.environ.get("COPILOT_DEADMAN_URL", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

```bash
"$PY" -m pytest tests/agents/copilot/test_runner.py -v -p no:cacheprovider
```

Expected: all passed. If `test_dry_run_records_would_be_alerts_and_never_sends` fails because the heartbeat is not due, check that `NOW.hour` (10) is at or after `heartbeat_hour_utc` (7).

- [ ] **Step 5: Smoke-test the entry script against a scratch dir, not the real results**

```bash
WATCHDOG_ENABLED=0 "$PY" scripts/copilot_watchdog.py
```

Expected: prints `copilot watchdog disabled (set WATCHDOG_ENABLED=1)` and exits 0. Do not run it enabled in the worktree.

- [ ] **Step 6: Commit**

```bash
git add config/copilot_checks.json src/agents/copilot/runner.py scripts/copilot_watchdog.py tests/agents/copilot/test_runner.py
git commit -m "feat(copilot): runner with dry-run default, config, heartbeat, maintenance and dead-man ping"
```

---

### Task 6: `/api/copilot` endpoint, guarded registration

**Files:**
- Create: `src/agents/copilot/endpoint.py`
- Modify: `scripts/status_server.py` (one guarded block directly after `app = Flask(__name__)`, currently line 65)
- Test: `tests/agents/copilot/test_endpoint.py`, `tests/agents/copilot/test_status_server_routes.py`

- [ ] **Step 1: Write the failing tests**

`tests/agents/copilot/test_endpoint.py`:

```python
import json

from flask import Flask

from src.agents.copilot.endpoint import register_copilot_endpoint, unknown_payload


def make_app(tmp_path):
    app = Flask(__name__)
    register_copilot_endpoint(app, tmp_path)
    return app


def test_serves_the_written_payload(tmp_path):
    payload = {"schema_version": 1, "overall": "ok", "checks": []}
    (tmp_path / "copilot.json").write_text(json.dumps(payload))
    resp = make_app(tmp_path).test_client().get("/api/copilot")
    assert resp.status_code == 200 and resp.get_json() == payload


def test_missing_file_returns_unknown_payload_not_an_error(tmp_path):
    resp = make_app(tmp_path).test_client().get("/api/copilot")
    body = resp.get_json()
    assert resp.status_code == 200 and body["overall"] == "unknown"
    assert body["checks"][0]["status"] == "unknown" and body["schema_version"] == 1


def test_corrupt_file_returns_unknown_payload(tmp_path):
    (tmp_path / "copilot.json").write_text("{not json")
    assert make_app(tmp_path).test_client().get("/api/copilot").get_json()["overall"] == "unknown"


def test_non_dict_json_returns_unknown_payload(tmp_path):
    (tmp_path / "copilot.json").write_text("[1, 2]")
    assert make_app(tmp_path).test_client().get("/api/copilot").get_json()["overall"] == "unknown"


def test_registration_failure_never_raises(monkeypatch, tmp_path):
    import src.agents.copilot.endpoint as ep

    monkeypatch.setattr(ep, "make_blueprint", lambda d: (_ for _ in ()).throw(RuntimeError("boom")))
    assert register_copilot_endpoint(Flask(__name__), tmp_path) is False


def test_only_get_is_allowed(tmp_path):
    assert make_app(tmp_path).test_client().post("/api/copilot").status_code == 405


def test_unknown_payload_shape():
    p = unknown_payload("why")
    assert p["overall"] == "unknown" and p["market"] == {"state": "unknown"} and p["ttl_s"] == 0
    assert p["generated_at"].endswith("Z")
```

`tests/agents/copilot/test_status_server_routes.py`:

```python
from scripts import status_server

EXISTING_ROUTES = {
    "/",
    "/legacy",
    "/mission",
    "/strategies",
    "/agents",
    "/api/status",
    "/api/strategies",
    "/api/mission",
    "/api/mission/activity",
    "/api/mission/epoch",
    "/api/refresh-trades",
}


def _rules():
    return {r.rule for r in status_server.app.url_map.iter_rules()}


def test_every_existing_dashboard_route_is_still_registered():
    assert EXISTING_ROUTES <= _rules()


def test_copilot_route_is_registered_and_get_only():
    rule = next(r for r in status_server.app.url_map.iter_rules() if r.rule == "/api/copilot")
    assert "GET" in rule.methods and "POST" not in rule.methods
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
"$PY" -m pytest tests/agents/copilot/test_endpoint.py tests/agents/copilot/test_status_server_routes.py -v -p no:cacheprovider
```

Expected: FAIL (`ModuleNotFoundError` for `endpoint`; `/api/copilot` not registered).

- [ ] **Step 3: Write minimal implementation**

`src/agents/copilot/endpoint.py`:

```python
"""Read-only GET /api/copilot, served from results/copilot.json.

Deliberately reads the file with plain json (no lock files) and never raises:
any problem yields an `unknown` payload, so a consumer can never mistake an
error for health. Registered behind a guard so it cannot break the dashboard.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, jsonify

logger = logging.getLogger(__name__)


def unknown_payload(reason, now=None):
    now = now or datetime.now(timezone.utc)
    return {
        "schema_version": 1,
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ttl_s": 0,
        "overall": "unknown",
        "market": {"state": "unknown"},
        "headline": {},
        "checks": [
            {
                "id": "copilot_payload",
                "status": "unknown",
                "severity": "crit",
                "evidence": reason,
                "threshold": "",
                "since": None,
            }
        ],
    }


def make_blueprint(results_dir):
    bp = Blueprint("copilot", __name__)
    path = Path(results_dir) / "copilot.json"

    @bp.route("/api/copilot", methods=["GET"])
    def api_copilot():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = None
        if not isinstance(data, dict):
            return jsonify(unknown_payload("copilot.json missing or unreadable"))
        return jsonify(data)

    return bp


def register_copilot_endpoint(app, results_dir) -> bool:
    try:
        app.register_blueprint(make_blueprint(results_dir))
        return True
    except Exception as exc:  # never let the co-pilot endpoint break the dashboard
        logger.warning("copilot endpoint not registered: %s", type(exc).__name__)
        return False
```

Modify `scripts/status_server.py`: directly after the line `app = Flask(__name__)` add exactly:

```python
try:  # co-pilot endpoint is optional and must never break the dashboard
    from src.agents.copilot.endpoint import register_copilot_endpoint
    register_copilot_endpoint(app, BASE_DIR / 'results')
except Exception as _copilot_exc:
    print(f"copilot endpoint not registered: {type(_copilot_exc).__name__}", file=sys.stderr)
```

(`sys` is already imported in that file; do not add other imports or change any existing route.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
"$PY" -m pytest tests/agents/copilot/test_endpoint.py tests/agents/copilot/test_status_server_routes.py -v -p no:cacheprovider
```

Expected: all passed. Then confirm the diff to `scripts/status_server.py` is only the added block:

```bash
git diff origin/main -- scripts/status_server.py
```

Expected: exactly the 5 added lines, no deletions.

- [ ] **Step 5: Commit**

```bash
git add src/agents/copilot/endpoint.py scripts/status_server.py tests/agents/copilot/test_endpoint.py tests/agents/copilot/test_status_server_routes.py
git commit -m "feat(copilot): read-only /api/copilot endpoint behind a registration guard"
```

---

### Task 7: Hardened systemd units

**Files:**
- Create: `deploy/forex-copilot-watchdog.service`
- Create: `deploy/forex-copilot-watchdog.timer`
- Test: `tests/agents/copilot/test_deploy_units.py`

- [ ] **Step 1: Write the failing test**

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SERVICE = (ROOT / "deploy" / "forex-copilot-watchdog.service").read_text()
TIMER = (ROOT / "deploy" / "forex-copilot-watchdog.timer").read_text()


def test_service_follows_repo_conventions():
    for line in (
        "Type=oneshot",
        "User=root",
        "WorkingDirectory=/root/forex",
        "EnvironmentFile=/root/forex/.env",
        "ExecStart=/root/forex/venv/bin/python /root/forex/scripts/copilot_watchdog.py",
        "SyslogIdentifier=forex-copilot-watchdog",
    ):
        assert line in SERVICE


def test_service_enforces_read_only_and_resource_limits():
    for line in (
        "ProtectSystem=strict",
        "ReadOnlyPaths=/root/forex",
        "ReadWritePaths=/root/forex/results",
        "Nice=10",
        "IOSchedulingClass=idle",
        "MemoryMax=256M",
        "TimeoutStartSec=60",
    ):
        assert line in SERVICE


def test_service_ships_disabled_and_dry_run_until_the_owner_opts_in():
    # WATCHDOG_ENABLED and COPILOT_ALERTS come from /root/forex/.env (EnvironmentFile),
    # set deliberately by the owner; the unit must not enable either itself.
    assert "WATCHDOG_ENABLED" not in SERVICE
    assert "COPILOT_ALERTS" not in SERVICE


def test_timer_is_not_persistent_and_runs_every_fifteen_minutes_off_the_others():
    assert "Persistent=false" in TIMER
    assert "OnCalendar=*-*-* *:07,22,37,52:00 UTC" in TIMER
    assert "Persistent=true" not in TIMER
```

- [ ] **Step 2: Run test to verify it fails**

```bash
"$PY" -m pytest tests/agents/copilot/test_deploy_units.py -v -p no:cacheprovider
```

Expected: FAIL, `FileNotFoundError` for the unit files.

- [ ] **Step 3: Write minimal implementation**

`deploy/forex-copilot-watchdog.service`:

```
[Unit]
Description=JARVIS co-pilot watchdog (writes results/copilot.json)
After=network.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/root/forex
EnvironmentFile=/root/forex/.env
ExecStart=/root/forex/venv/bin/python /root/forex/scripts/copilot_watchdog.py
TimeoutStartSec=60
Nice=10
IOSchedulingClass=idle
MemoryMax=256M
ProtectSystem=strict
ReadOnlyPaths=/root/forex
ReadWritePaths=/root/forex/results
StandardOutput=journal
StandardError=journal
SyslogIdentifier=forex-copilot-watchdog

[Install]
WantedBy=multi-user.target
```

`deploy/forex-copilot-watchdog.timer`:

```
[Unit]
Description=Co-pilot watchdog, every 15 minutes

[Timer]
OnCalendar=*-*-* *:07,22,37,52:00 UTC
AccuracySec=1min
Persistent=false

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Run test to verify it passes**

```bash
"$PY" -m pytest tests/agents/copilot/test_deploy_units.py -v -p no:cacheprovider
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add deploy/forex-copilot-watchdog.service deploy/forex-copilot-watchdog.timer tests/agents/copilot/test_deploy_units.py
git commit -m "feat(copilot): hardened oneshot unit and timer (read-only, resource-limited, no catch-up burst)"
```

---

### Task 8: Verification and handoff

**Files:** none.

- [ ] **Step 1: Run the whole copilot suite and the surrounding suites**

```bash
"$PY" -m pytest tests/agents/copilot -q -p no:cacheprovider
"$PY" -m pytest tests/agents -q -m "not slow" -p no:cacheprovider 2>&1 | tail -n 4
```

Expected: copilot suite all green; the wider agents suite matches the Task 0 baseline (no new failures).

- [ ] **Step 2: Prove read-only behaviour against a scratch copy of realistic inputs**

Create a scratch directory outside both repos, copy `config/strategy_registry.json` and `results/live_trades.json` from the worktree into `scratch/config` and `scratch/results`, run `run_once(scratch, dry_run=True)` from a Python one-liner, and confirm that only `copilot.json`, `copilot_state.json` (and `.lock` files) appear in `scratch/results`, and that nothing under the worktree changed (`git status --short` clean). Report the printed overall status.

- [ ] **Step 3: Confirm the dashboard diff is minimal**

```bash
git diff origin/main --stat
git diff origin/main -- scripts/status_server.py
```

Expected: only the files listed in the File structure section; `status_server.py` shows a 5-line addition and no deletions.

- [ ] **Step 4: Report, do not deploy**

Report: branch name, commit list, test counts versus baseline, and the scratch-run result. Do not push, do not SSH, do not deploy. Deployment happens only on the owner's explicit go-ahead, after Plan A-2's remaining checks and an independent review. The deploy sequence is: copy the units, add `WATCHDOG_ENABLED=1` to `/root/forex/.env` (the unit ships disabled), `systemctl enable --now forex-copilot-watchdog.timer`, soak in dry-run for at least one weekend and one real deploy, then add `COPILOT_ALERTS=on`. Rollback is removing `WATCHDOG_ENABLED` or disabling the timer.

Known limits to carry into Plan A-2: `entry_permitted` false-reasons (emergency halt, portfolio R cap, correlated-group cap) are not checked; `trading_days_since` counts today as a full day, so ages can read up to a day high; `market.next_change` and `since` are not populated in version 1.
