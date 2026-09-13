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
        const direction = computeDirection(entry.bid, entry.baseline)
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
