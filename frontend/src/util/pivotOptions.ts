import { useState } from "react"
import type { PivotOptions } from "../api/backend"

const KEY = "putcafe.pivotOptions"

export const DEFAULT_PIVOT_OPTIONS: PivotOptions = { enabled: true, lookback: 3, alternation: true }

function load(): PivotOptions {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as PivotOptions | null
    return stored ? { ...DEFAULT_PIVOT_OPTIONS, ...stored } : DEFAULT_PIVOT_OPTIONS
  } catch {
    return DEFAULT_PIVOT_OPTIONS
  }
}

export function usePivotOptions() {
  const [options, setOptions] = useState<PivotOptions>(load)

  return {
    options,
    set(patch: Partial<PivotOptions>) {
      const next = { ...options, ...patch }
      localStorage.setItem(KEY, JSON.stringify(next))
      setOptions(next)
      return next
    },
  }
}
