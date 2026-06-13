/** Tiny dependency-free SVG charts for the benchmark UI. Kept minimal on
 * purpose — a leaderboard + distribution don't warrant a charting lib. */

const POS = "#3fb950" // green
const NEG = "#f85149" // red
const AXIS = "#30363d"
const TEXT = "#8b949e"

/** Histogram of values into `bins` buckets; bars colored by bucket-center sign.
 * Used for the distribution of per-window return_pct. */
export function Histogram({ values, bins = 30, height = 220 }: {
  values: number[]
  bins?: number
  height?: number
}) {
  if (!values.length) return <Empty h={height} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const width = bins * 18
  const counts = new Array(bins).fill(0)
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor(((v - min) / span) * bins))
    counts[i]++
  }
  const maxCount = Math.max(...counts)
  const bw = width / bins
  const zeroX = ((0 - min) / span) * width

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
      style={{ maxWidth: width }}>
      {/* zero line */}
      {min < 0 && max > 0 && (
        <line x1={zeroX} y1={0} x2={zeroX} y2={height - 18} stroke={AXIS} strokeDasharray="3 3" />
      )}
      {counts.map((c, i) => {
        const h = maxCount ? (c / maxCount) * (height - 24) : 0
        const center = min + ((i + 0.5) / bins) * span
        return (
          <rect key={i} x={i * bw + 1} y={height - 18 - h} width={bw - 2} height={h}
            fill={center >= 0 ? POS : NEG} opacity={0.85}>
            <title>{`${center.toFixed(2)}%: ${c} sessions`}</title>
          </rect>
        )
      })}
      <text x={2} y={height - 4} fill={TEXT} fontSize={9}>{min.toFixed(1)}%</text>
      <text x={width - 2} y={height - 4} fill={TEXT} fontSize={9} textAnchor="end">{max.toFixed(1)}%</text>
    </svg>
  )
}

/** Horizontal signed bars (value can be ±). Used for per-market avg return. */
export function HBars({ items, onClick }: {
  items: { label: string; value: number; active?: boolean }[]
  onClick?: (label: string) => void
}) {
  if (!items.length) return <Empty h={120} />
  const maxAbs = Math.max(...items.map((d) => Math.abs(d.value)), 0.0001)
  return (
    <div className="bench-hbars">
      {items.map((d) => {
        const pct = (Math.abs(d.value) / maxAbs) * 50 // half-width = 50%
        const pos = d.value >= 0
        return (
          <div key={d.label} className={`bench-hbar${d.active ? " active" : ""}`}
            onClick={onClick ? () => onClick(d.label) : undefined}
            style={{ cursor: onClick ? "pointer" : "default" }}
            title={`${d.label}: ${d.value.toFixed(2)}%`}>
            <span className="bench-hbar-label">{d.label}</span>
            <span className="bench-hbar-track">
              <span className="bench-hbar-fill" style={{
                width: `${pct}%`,
                marginLeft: pos ? "50%" : `${50 - pct}%`,
                background: pos ? POS : NEG,
              }} />
            </span>
            <span className="bench-hbar-val" style={{ color: pos ? POS : NEG }}>
              {d.value >= 0 ? "+" : ""}{d.value.toFixed(2)}%
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Empty({ h }: { h: number }) {
  return <div style={{ height: h, display: "grid", placeItems: "center", color: TEXT }}>no data</div>
}
