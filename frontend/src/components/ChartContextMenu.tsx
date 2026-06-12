import { useEffect, useRef } from "react"
import type { Candle } from "../binance/api"

export interface ContextMenuState {
  x: number
  y: number
  time: number
  candle: Candle | null
}

interface Props {
  menu: ContextMenuState
  onSetStart: (time: number) => void
  onSetEnd: (time: number) => void
  onStartReplayHere: (time: number) => void
  onSaveCandle: (candle: Candle) => void
  onClose: () => void
}

export default function ChartContextMenu({ menu, onSetStart, onSetEnd, onStartReplayHere, onSaveCandle, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const item = (label: string, fn: (t: number) => void) => (
    <button
      className="ctx-item"
      onClick={() => {
        fn(menu.time)
        onClose()
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="ctx-menu" ref={ref} style={{ left: menu.x, top: menu.y }}>
      {item("Set backtest start here", onSetStart)}
      {item("Set backtest end here", onSetEnd)}
      {item("Start replay here", onStartReplayHere)}
      {menu.candle && (
        <button
          className="ctx-item"
          onClick={() => {
            onSaveCandle(menu.candle!)
            onClose()
          }}
        >
          Save candle
        </button>
      )}
    </div>
  )
}
