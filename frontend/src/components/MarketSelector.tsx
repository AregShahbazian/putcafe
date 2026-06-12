import { useEffect, useRef, useState } from "react"
import type { Market } from "../binance/api"

const MAX_ROWS = 200

interface Props {
  markets: Market[]
  selected: Market
  error: string | null
  onSelect: (market: Market) => void
}

export default function MarketSelector({ markets, selected, error, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [open])

  const q = query.trim().toUpperCase()
  const filtered = q
    ? markets.filter(m => m.symbol.includes(q) || m.baseAsset.includes(q))
    : markets

  const pick = (m: Market) => {
    onSelect(m)
    setOpen(false)
    setQuery("")
  }

  return (
    <div className="market-selector" ref={wrapRef}>
      <button className="selector-button" onClick={() => setOpen(o => !o)}>
        {selected.baseAsset}/{selected.quoteAsset} ▾
      </button>
      {open && (
        <div className="selector-panel">
          <input
            ref={inputRef}
            placeholder="Search markets…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") setOpen(false)
              if (e.key === "Enter" && filtered.length > 0) pick(filtered[0])
            }}
          />
          <div className="selector-list">
            {error && <div className="selector-empty">Failed to load markets: {error}</div>}
            {!error && filtered.length === 0 && <div className="selector-empty">No matches</div>}
            {filtered.slice(0, MAX_ROWS).map(m => (
              <button
                key={m.symbol}
                className={m.symbol === selected.symbol ? "selector-row selected" : "selector-row"}
                onClick={() => pick(m)}
              >
                {m.baseAsset}/{m.quoteAsset}
              </button>
            ))}
            {filtered.length > MAX_ROWS && (
              <div className="selector-empty">+{filtered.length - MAX_ROWS} more — refine search</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
