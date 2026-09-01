import { chromium, type Browser } from "playwright"
import type { Backend, BackendSession } from "./types.js"

export function localBackend(opts: { headless?: boolean } = {}): Backend {
  return {
    name: "local",
    async open(): Promise<BackendSession> {
      const browser: Browser = await chromium.launch({ headless: opts.headless ?? true })
      const context = await browser.newContext()
      const page = await context.newPage()
      return {
        page,
        async replayUrl() {
          return null
        },
        async close() {
          await browser.close()
        },
      }
    },
  }
}
