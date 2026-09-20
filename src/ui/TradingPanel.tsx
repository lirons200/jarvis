import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  formatPnl, lossBudgetUsed, openPositions, recentJournal, formatJournalLine,
  isSnapshotStale, statusLabel, stopLossLabel, protectionWarning, needsAttention,
} from '../lib/tradingDashboard'

/**
 * Read-only trading status. Renders nothing until the bridge reports trading
 * enabled. Deliberately has no controls: arming, halting and orders stay on
 * the voice/Telegram paths.
 */
export function TradingPanel() {
  const snap = useStore((s) => s.trading)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Re-evaluate staleness even when no new snapshot arrives (bridge died).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  if (!snap || !snap.enabled) return null

  const stale = isSnapshotStale(snap.at, nowMs)
  const warning = protectionWarning(snap, stale)
  const positions = openPositions(snap)
  const used = lossBudgetUsed(snap.pnl)
  const total = snap.pnl.realizedToday === null || snap.pnl.unrealized === null
    ? null
    : snap.pnl.realizedToday + snap.pnl.unrealized

  return (
    <aside className={`trading-panel trading-${snap.halted ? 'halted' : 'live'}${stale ? ' trading-stale' : ''}`}>
      <div className="trading-head">
        <span className="trading-title">TRADING</span>
        <span className="trading-state">{statusLabel(snap, stale)}</span>
      </div>
      {snap.halted && snap.haltReason && <div className="trading-halt">{snap.haltReason}</div>}
      {needsAttention(snap, stale) && <span className="trading-badge">!</span>}

      <div className="trading-row">
        <span>P&amp;L today</span>
        <span>{formatPnl(total)} / -{snap.pnl.dailyLossLimit}</span>
      </div>
      <div className="trading-bar">
        <div className="trading-bar-fill" style={{ width: `${(used ?? 0) * 100}%` }} />
      </div>

      {snap.positions === null && <div className="trading-warn">positions unavailable</div>}
      {positions.map((p) => (
        <div key={p.pair} className="trading-row">
          <span>{p.pair.replace('_', '/')}</span>
          <span>
            {p.units}
            {' '}{stopLossLabel(p, stale)}
          </span>
        </div>
      ))}
      {warning && <div className="trading-warn">{warning}</div>}

      <div className="trading-journal">
        {recentJournal(snap.journal).map((e, i) => (
          <div key={`${e.at}-${i}`}>{formatJournalLine(e)}</div>
        ))}
      </div>
    </aside>
  )
}
