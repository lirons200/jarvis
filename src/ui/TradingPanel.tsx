import { useStore } from '../store'
import {
  tradingState, formatPnl, lossBudgetUsed, openPositions,
  hasUnprotectedPosition, recentJournal, formatJournalLine,
} from '../lib/tradingDashboard'

/**
 * Read-only trading status. Renders nothing until the bridge reports trading
 * enabled. Deliberately has no controls: arming, halting and orders stay on
 * the voice/Telegram paths.
 */
export function TradingPanel() {
  const snap = useStore((s) => s.trading)
  if (!snap || !snap.enabled) return null

  const state = tradingState(snap)
  const positions = openPositions(snap)
  const used = lossBudgetUsed(snap.pnl)
  const total = snap.pnl.realizedToday === null || snap.pnl.unrealized === null
    ? null
    : snap.pnl.realizedToday + snap.pnl.unrealized

  return (
    <aside className={`trading-panel trading-${state}`}>
      <div className="trading-head">
        <span className="trading-title">TRADING</span>
        <span className="trading-state">{state.toUpperCase()}</span>
      </div>
      {snap.halted && snap.haltReason && <div className="trading-halt">{snap.haltReason}</div>}

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
            {p.stopLossConfirmed ? ' SL ok' : ' NO STOP'}
          </span>
        </div>
      ))}
      {hasUnprotectedPosition(snap) && <div className="trading-warn">position without confirmed stop-loss</div>}

      <div className="trading-journal">
        {recentJournal(snap.journal).map((e, i) => (
          <div key={`${e.at}-${i}`}>{formatJournalLine(e)}</div>
        ))}
      </div>
    </aside>
  )
}
