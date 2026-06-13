import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import BenchView from "./bench/BenchView"
import "./app.css"

/** Minimal hash router: `#/bench` shows the benchmark dashboard, anything else
 * the trading app. A floating link enters the dashboard; no router dependency. */
function Root() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  if (hash.startsWith("#/bench")) {
    return <BenchView onBack={() => { window.location.hash = "" }} />
  }
  return (
    <>
      <App />
      <button className="bench-fab" onClick={() => { window.location.hash = "#/bench" }}>
        📊 Benchmarks
      </button>
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
