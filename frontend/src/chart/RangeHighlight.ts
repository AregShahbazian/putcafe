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

const LINE_COLOR = "#ff9800"
const FILL_COLOR = "rgba(255, 152, 0, 0.08)"

export interface RangeSelection {
  start?: number // unix seconds
  end?: number
}

interface Drawn {
  startX: number | null
  endX: number | null
  height: number
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private drawn: Drawn) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    const { startX, endX, height } = this.drawn
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      if (startX !== null && endX !== null) {
        ctx.fillStyle = FILL_COLOR
        ctx.fillRect(Math.min(startX, endX), 0, Math.abs(endX - startX), height)
      }
      const line = (x: number, label: string) => {
        ctx.strokeStyle = LINE_COLOR
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = LINE_COLOR
        ctx.font = "11px sans-serif"
        ctx.fillText(label, x + 4, 14)
      }
      if (startX !== null) line(startX, "Backtest start")
      if (endX !== null) line(endX, "Backtest end")
    })
  }
}

class PaneView implements IPrimitivePaneView {
  private drawn: Drawn = { startX: null, endX: null, height: 0 }

  constructor(private owner: RangeHighlight) {}

  update() {
    const { chart, selection } = this.owner
    if (!chart) return
    const ts = chart.timeScale()
    const toX = (t?: number) =>
      t === undefined ? null : ts.timeToCoordinate(t as UTCTimestamp)
    this.drawn = {
      startX: toX(selection.start),
      endX: toX(selection.end),
      height: chart.paneSize().height,
    }
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom"
  }

  renderer() {
    return new Renderer(this.drawn)
  }
}

/** Shaded backtest range + labeled vertical boundary lines (quiz-style pickers). */
export class RangeHighlight implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null
  series: ISeriesApi<"Candlestick"> | null = null
  selection: RangeSelection = {}
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

  setSelection(selection: RangeSelection) {
    this.selection = selection
    this.requestUpdate?.()
  }

  updateAllViews() {
    this.view.update()
  }

  paneViews() {
    return [this.view]
  }
}
