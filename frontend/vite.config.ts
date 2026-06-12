import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  // VITE_LOCAL_BOT=1 yarn dev — test bot-backend changes pre-merge: /api/bot/*
  // goes to a locally run bot (uvicorn :8102), /api/positions/* stays on the
  // deployed API, and VITE_API_BASE is blanked so the app routes via this proxy.
  const localBot = env.VITE_LOCAL_BOT === "1"
  return {
    // Relative asset paths — one build works at /web/, /web/staging/, /web/<slot>/.
    base: "./",
    plugins: [react()],
    ...(localBot && {
      define: { "import.meta.env.VITE_API_BASE": JSON.stringify("") },
      server: {
        proxy: {
          "/api/bot": "http://localhost:8102",
          "/api/positions": { target: env.VITE_API_BASE, changeOrigin: true },
        },
      },
    }),
  }
})
