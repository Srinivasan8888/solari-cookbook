import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chromium, type BrowserServer } from "playwright"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { observe } from "../src/observe.js"
import { runFlow } from "../src/runtime.js"
import { loadFlow } from "../src/spec.js"
import type { Backend, BackendSession } from "../src/backends/types.js"

/**
 * Solari does not launch a browser locally -- it hands you a wsEndpoint and you
 * connect Playwright over the wire protocol to Chromium running elsewhere.
 * Every other test here uses chromium.launch(), which is a different topology.
 *
 * launchServer() + connect() reproduces the remote shape exactly, so the parts
 * that could plausibly differ over a wire connection -- in-page evaluate, the
 * __name shim, context and page lifecycle, close ordering -- are exercised
 * without needing a Solari account.
 */
let server: BrowserServer
let site: DemoServer

beforeAll(async () => {
  server = await chromium.launchServer()
  site = await serveVariant("v1")
})
afterAll(async () => {
  await server.close()
  await site.close()
})

function remoteBackend(): Backend {
  return {
    name: "local",
    async open(): Promise<BackendSession> {
      const browser = await chromium.connect(server.wsEndpoint())
      const context = await browser.newContext()
      const page = await context.newPage()
      return {
        page,
        sessionId: "remote-test",
        async replayUrl() { return null },
        async close() { await browser.close() },
      }
    },
  }
}

describe("remote browser over the Playwright wire protocol", () => {
  it("observe() works against a browser it did not launch", async () => {
    const browser = await chromium.connect(server.wsEndpoint())
    try {
      const page = await browser.newPage()
      await page.goto(site.url)
      // The __name shim is injected via page.evaluate with a raw string. If a
      // wire connection handled string evaluate differently, this is where it
      // would surface.
      const snapshot = await observe(page)
      expect(snapshot.nodes.find((n) => n.name === "Export CSV")).toBeDefined()
      expect(snapshot.nodes.find((n) => n.selector === "#month")?.name).toBe("Billing month")
    } finally {
      await browser.close()
    }
  }, 60_000)

  it("runs the committed flow green over a remote connection", async () => {
    const onDisk = loadFlow(new URL("../flows/invoice-export.json", import.meta.url).pathname)
    const rebased = {
      ...onDisk,
      url: site.url,
      steps: onDisk.steps.map((s) => (s.action === "goto" ? { ...s, url: site.url } : s)),
    }
    const result = await runFlow(rebased, { month: "2026-08" }, {
      backend: remoteBackend(), healer: null,
    })
    expect(result.status).toBe("ok")
    expect(result.telemetry.llmCalls).toBe(0)
    expect(result.output.status).toContain("3 results")
  }, 60_000)

  it("exits cleanly after close, which is Solari's documented footgun", async () => {
    const browser = await chromium.connect(server.wsEndpoint())
    const page = await browser.newPage()
    await page.goto(site.url)
    await browser.close()
    expect(browser.isConnected()).toBe(false)
  }, 60_000)
})
