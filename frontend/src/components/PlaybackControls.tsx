import { useEffect } from "react"
import { SPEEDS, type EngineSnapshot } from "../backtest/engine"

interface Props {
  snap: EngineSnapshot
  onPlay: () => void
  onPause: () => void
  onStepForward: () => void
  onStepBack: () => void
  onRestart: () => void
  onStop: () => void
  onSpeed: (speed: number) => void
  onAutoResume: (v: boolean) => void
}

/** Trading-terminal-style replay strip: status badge, restart, step back, play/pause,
 * step forward, stop, speed, auto-resume, current candle time.
 * Shortcuts (Shift held): ↓ play/pause · → step · ← step back · R restart · Q stop. */
export default function PlaybackControls(p: Props) {
  const { snap } = p
  const playing = snap.status === "playing"
  const current = snap.upTo > 0 ? snap.candles[snap.upTo - 1] : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.target as HTMLElement)?.tagName === "INPUT") return
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          playing ? p.onPause() : p.onPlay()
          break
        case "ArrowRight":
          e.preventDefault()
          p.onStepForward()
          break
        case "ArrowLeft":
          e.preventDefault()
          p.onStepBack()
          break
        case "R":
          e.preventDefault()
          p.onRestart()
          break
        case "Q":
          e.preventDefault()
          p.onStop()
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div className="playback-strip">
      <span className={`status-badge status-${snap.status}`}>{snap.status.toUpperCase()}</span>
      <button title="Restart" onClick={p.onRestart}>⏮⏮</button>
      <button title="Step back" onClick={p.onStepBack} disabled={snap.upTo <= 1}>⏮</button>
      {playing ? (
        <button title="Pause" onClick={p.onPause}>⏸</button>
      ) : (
        <button title="Play" onClick={p.onPlay} disabled={snap.status === "finished" || snap.status === "loading"}>▶</button>
      )}
      <button title="Step forward" onClick={p.onStepForward} disabled={playing || snap.status === "finished"}>⏭</button>
      <button title="Stop (exit replay)" className="stop-button" onClick={p.onStop}>⏹</button>
      <label className="speed-label">
        Speed
        <select value={snap.speed} onChange={e => p.onSpeed(Number(e.target.value))}>
          {SPEEDS.map(s => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
      </label>
      <label
        className="auto-resume"
        title="Auto-resume playback after triggering order/alert."
      >
        <input
          type="checkbox"
          checked={snap.autoResume}
          onChange={e => p.onAutoResume(e.target.checked)}
        />
        Auto-resume
      </label>
      {current && (
        <span className="playback-time">
          {new Date(current.time * 1000).toLocaleString()}
        </span>
      )}
    </div>
  )
}
