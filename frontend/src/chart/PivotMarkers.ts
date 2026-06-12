import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts"

const HIGH_COLOR = "#f0a431"
const LOW_COLOR = "#42a5f5"
const W = 11 // triangle base width (px)
const H = 9 // triangle height (px)
const GAP = 3 // gap between the bar's extreme and the triangle tip (px)

export interface PivotMark {
  time: number // unix seconds
  type: "high" | "low"
  price: number
}

interface Drawn {
  x: number
  y: number // tip y (at the bar extreme + gap)
  dir: "up" | "down"
  color: string
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private items: Drawn[]) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const { x, y, dir, color } of this.items) {
        ctx.fillStyle = color
        ctx.beginPath()
        if (dir === "down") {
          // Above a swing high, pointing down (tip near the high).
          ctx.moveTo(x, y)
          ctx.lineTo(x - W / 2, y - H)
          ctx.lineTo(x + W / 2, y - H)
        } else {
          // Below a swing low, pointing up (tip near the low).
          ctx.moveTo(x, y)
          ctx.lineTo(x - W / 2, y + H)
          ctx.lineTo(x + W / 2, y + H)
        }
        ctx.closePath()
        ctx.fill()
      }
    })
  }
}

class PaneView implements IPrimitivePaneView {
  private items: Drawn[] = []

  constructor(private owner: PivotMarkers) {}

  update() {
    const { chart, series, pivots } = this.owner
    if (!chart || !series) {
      this.items = []
      return
    }
    const ts = chart.timeScale()
    const out: Drawn[] = []
    for (const pv of pivots) {
      const x = ts.timeToCoordinate(pv.time as UTCTimestamp)
      const yPrice = series.priceToCoordinate(pv.price)
      if (x === null || yPrice === null) continue
      out.push(
        pv.type === "high"
          ? { x, y: yPrice - GAP, dir: "down", color: HIGH_COLOR }
          : { x, y: yPrice + GAP, dir: "up", color: LOW_COLOR },
      )
    }
    this.items = out
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top"
  }

  renderer() {
    return new Renderer(this.items)
  }
}

/** Swing-high/low pivots drawn as filled triangles (▼ above highs, ▲ below
 * lows), distinct from the arrow markers used for trades. */
export class PivotMarkers implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null
  series: ISeriesApi<"Candlestick"> | null = null
  pivots: PivotMark[] = []
  private view = new PaneView(this)
  private requestUpdate: (() => void) | null = null

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart
    this.series = param.series as ISeriesApi<"Candlestick">
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.chart = null
    this.series = null
    this.requestUpdate = null
  }

  setPivots(pivots: PivotMark[]) {
    this.pivots = pivots
    this.requestUpdate?.()
  }

  updateAllViews() {
    this.view.update()
  }

  paneViews() {
    return [this.view]
  }
}
