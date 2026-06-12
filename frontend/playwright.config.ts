import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  // System Chrome — no browser download needed for a personal dev box.
  // Dedicated port: 5173 may be another worktree's dev server (without this
  // branch's code), which reuseExistingServer would happily reuse.
  use: { baseURL: "http://localhost:5183", channel: "chrome" },
  webServer: {
    command: "yarn dev --port 5183 --strictPort",
    url: "http://localhost:5183",
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
