/** Playwright on this machine. No key, no network beyond the demo site. */
import { chromium, type Browser } from "playwright"
import { EXTRACT, type Backend, type PageProbe } from "./backend.js"

export async function localBackend(): Promise<Backend> {
  // Memoize the PROMISE, not the browser. `browser ??= await launch()` is not
  // atomic across the await: every concurrent probe would see null and launch
  // its own Chromium, and all but the last would leak -- the process then
  // never exits because orphaned children hold the event loop open.
  let launching: Promise<Browser> | null = null
  const get = () => (launching ??= chromium.launch())
  return {
    name: "local",
    async probe(url, cookies): Promise<PageProbe> {
      const b = await get()
      const origin = new URL(url).origin
      const ctx = await b.newContext()
      await ctx.addCookies(cookies.map((c) => ({ ...c, url: origin })))
      const page = await ctx.newPage()
      await page.goto(url, { waitUntil: "load" })
      const probe = { testids: await page.evaluate(EXTRACT), title: await page.title(), url: page.url() }
      await ctx.close()
      return probe
    },
    async close() { if (launching) await (await launching).close() },
  }
}
