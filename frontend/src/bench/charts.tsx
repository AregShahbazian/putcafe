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

/** Horizontal box-and-whisker per algo on a shared scale — the cross-algo
 * return-distribution comparison (identical windows → directly comparable). */
export function BoxPlot({ items }: {
  items: { algo: string; min: number; p25: number; median: number; p75: number; max: number }[]
}) {
  if (!items.length) return <Empty h={120} />
  const lo = Math.min(...items.map((d) => d.min))
  const hi = Math.max(...items.map((d) => d.max))
  const span = hi - lo || 1
  const W = 1000, L = 130, R = 70, rowH = 30, axisH = 18
  const plotW = W - L - R
  const x = (v: number) => L + ((v - lo) / span) * plotW
  const height = axisH + items.length * rowH + 6
  const zeroX = x(0)
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${height}`} style={{ fontSize: 11 }}>
      {/* axis */}
      <text x={L} y={12} fill={TEXT} fontSize={10}>{lo.toFixed(1)}%</text>
      <text x={W - R} y={12} fill={TEXT} fontSize={10} textAnchor="end">{hi.toFixed(1)}%</text>
      {lo < 0 && hi > 0 && (
        <line x1={zeroX} y1={axisH} x2={zeroX} y2={height} stroke={AXIS} strokeDasharray="3 3" />
      )}
      {items.map((d, i) => {
        const cy = axisH + i * rowH + rowH / 2
        const col = d.median >= 0 ? POS : NEG
        return (
          <g key={d.algo}>
            <text x={4} y={cy + 4} fill="#c9d1d9" fontSize={12}>{d.algo}</text>
            {/* whisker */}
            <line x1={x(d.min)} y1={cy} x2={x(d.max)} y2={cy} stroke={col} opacity={0.5} />
            <line x1={x(d.min)} y1={cy - 5} x2={x(d.min)} y2={cy + 5} stroke={col} opacity={0.6} />
            <line x1={x(d.max)} y1={cy - 5} x2={x(d.max)} y2={cy + 5} stroke={col} opacity={0.6} />
            {/* box */}
            <rect x={x(d.p25)} y={cy - 8} width={Math.max(1, x(d.p75) - x(d.p25))} height={16}
              fill={col} opacity={0.28} stroke={col} />
            {/* median */}
            <line x1={x(d.median)} y1={cy - 8} x2={x(d.median)} y2={cy + 8} stroke={col} strokeWidth={2} />
            <text x={W - R + 6} y={cy + 4} fill={col} fontSize={11}>
              {d.median >= 0 ? "+" : ""}{d.median.toFixed(2)}%
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Empty({ h }: { h: number }) {
  return <div style={{ height: h, display: "grid", placeItems: "center", color: TEXT }}>no data</div>
}
