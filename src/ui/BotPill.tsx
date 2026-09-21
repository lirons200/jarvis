import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { missingPill, pill } from '../lib/botStatus'

/** Read-only bot health pill. UNKNOWN is shown loudly and never as the last good value. */
export function BotPill() {
  const status = useStore((s) => s.botStatus)
  const [mountedAt] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  // No answer at all (bridge down at page load) must not look like "nothing to show".
  const p = status ? pill(status, nowMs) : missingPill(nowMs, mountedAt)
  if (!p) return null
  return (
    <div className={`bot-pill bot-${p.level}`} title={p.title} role="status">
      {p.text}
    </div>
  )
}
