import { useEffect, useState } from "react"
import { fetchMarkets, type Market } from "./binance/api"
import ChartView from "./chart/ChartView"
import MarketSelector from "./components/MarketSelector"
import TimeframeSelector, { type Interval } from "./components/TimeframeSelector"

const DEFAULT_MARKET: Market = { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" }

export default function App() {
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [market, setMarket] = useState<Market>(DEFAULT_MARKET)
  const [interval, setInterval] = useState<Interval>("1h")

  useEffect(() => {
    fetchMarkets()
      .then(setMarkets)
      .catch((e: unknown) => setMarketsError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">putcafe</span>
        <MarketSelector
          markets={markets}
          selected={market}
          error={marketsError}
          onSelect={setMarket}
        />
        <TimeframeSelector selected={interval} onSelect={setInterval} />
      </header>
      <main className="app-main">
        <ChartView key={`${market.symbol}-${interval}`} symbol={market.symbol} interval={interval} />
      </main>
    </div>
  )
}
