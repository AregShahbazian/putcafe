import { useEffect, useRef } from "react"

export interface ContextMenuState {
  x: number
  y: number
  time: number
}

interface Props {
  menu: ContextMenuState
  onSetStart: (time: number) => void
  onSetEnd: (time: number) => void
  onStartReplayHere: (time: number) => void
  onClose: () => void
}

export default function ChartContextMenu({ menu, onSetStart, onSetEnd, onStartReplayHere, onClose }: Props) {
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
    </div>
  )
}
