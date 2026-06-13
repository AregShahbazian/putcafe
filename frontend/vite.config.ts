import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  // VITE_LOCAL_BOT=1 yarn dev — test bot-backend changes pre-merge: /api/bot/*
  // goes to a locally run bot (uvicorn :8102), /api/positions/* stays on the
  // deployed API, and VITE_API_BASE is blanked so the app routes via this proxy.
  const localBot = env.VITE_LOCAL_BOT === "1"
  // VITE_LOCAL_STACK=1 yarn dev — pairs with scripts/dev/local/run-stack.sh:
  // the WHOLE API stack runs locally (db+positions+bot), so both /api/positions/*
  // and /api/bot/* proxy to the local containers and VITE_API_BASE is blanked.
  const localStack = env.VITE_LOCAL_STACK === "1"
  return {
    // Relative asset paths — one build works at /web/, /web/staging/, /web/<slot>/.
    base: "./",
    plugins: [react()],
    ...(localStack && {
      define: { "import.meta.env.VITE_API_BASE": JSON.stringify("") },
      server: {
        proxy: {
          "/api/bot": "http://localhost:8102",
          "/api/positions": "http://localhost:8101",
        },
      },
    }),
    ...(localBot && !localStack && {
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
