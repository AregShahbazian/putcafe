import { useState } from "react"
import type { Market } from "../binance/api"
import type { Interval } from "../components/TimeframeSelector"
import type { PanelConfig } from "../components/BacktestPanel"
import type { PivotOptions } from "../api/backend"

/** A full, reproducible backtest setup. The range is stored absolute (unix
 * seconds) so a preset always points at the same immutable historical klines —
 * loading + running it is deterministic. */
export interface Preset {
  name: string
  market: Market
  interval: Interval
  rangeStart: number
  rangeEnd: number
  config: PanelConfig
  pivotOptions: PivotOptions
}

const KEY = "putcafe.presets"

function load(): Preset[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Preset[]
  } catch {
    return []
  }
}

function store(items: Preset[]): void {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export function usePresets() {
  const [presets, setPresets] = useState<Preset[]>(load)

  const apply = (items: Preset[]) => {
    store(items)
    setPresets(items)
  }

  return {
    presets,
    /** Upsert by name — re-saving a name overwrites that preset. */
    save(preset: Preset) {
      const without = presets.filter(p => p.name !== preset.name)
      apply([...without, preset])
    },
    remove(name: string) {
      apply(presets.filter(p => p.name !== name))
    },
  }
}
