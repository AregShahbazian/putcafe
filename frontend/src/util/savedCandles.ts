import { useState } from "react"
import type { Candle } from "../binance/api"

export interface SavedCandle {
  market: string
  interval: string
  candle: Candle
}

const KEY = "putcafe.savedCandles"

function load(): SavedCandle[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedCandle[]
  } catch {
    return []
  }
}

function store(items: SavedCandle[]): void {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export function useSavedCandles() {
  const [saved, setSaved] = useState<SavedCandle[]>(load)

  const apply = (items: SavedCandle[]) => {
    store(items)
    setSaved(items)
  }

  return {
    saved,
    save(item: SavedCandle) {
      const dup = saved.some(
        s => s.market === item.market && s.interval === item.interval && s.candle.time === item.candle.time,
      )
      if (!dup) apply([...saved, item])
    },
    remove(index: number) {
      apply(saved.filter((_, i) => i !== index))
    },
    clear() {
      apply([])
    },
  }
}
