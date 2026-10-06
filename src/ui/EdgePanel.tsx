import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { edgeView } from '../lib/botEdge'

/** Read-only edge-proof panel. No controls. Backtest-only evidence is labelled, never shown as proof. */
export function EdgePanel() {
  const edge = useStore((s) => s.botEdge)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const v = edge ? edgeView(edge, nowMs) : null
  if (!v) return null
  return (
    <aside className={`edge-panel panel panel-${v.level === 'proven' ? 'green' : v.level === 'promising' ? 'amber' : v.level === 'noedge' ? 'red' : 'default'}`} role="status">
      <div className="p-head"><span className="p-title">EDGE</span><span className="hud-tag">read-only</span></div>
      <span className="hud-metric hud-hot">{v.verdict}</span>
      <span className="hud-unit">portfolio verdict</span>
      <div className="hud-grid edge-grid">
        <div className="hud-main"><span className="hud-sub">EV</span><span className="hud-label">{v.ev}</span></div>
        <div className="hud-main"><span className="hud-sub">CI95</span><span className="hud-label">{v.ci95}</span></div>
        <div className="hud-main"><span className="hud-sub">LIVE N</span><span className="hud-label">{v.live}</span></div>
      </div>
      <div className="hud-bar" style={{ ['--v' as string]: v.progress }} />
      {v.honesty && <p className="hud-note edge-honesty">{v.honesty}</p>}
    </aside>
  )
}
