// Run under `tsx` (not vitest) so esbuild's `__name` injection is in play.
// See the shim in src/observe.ts.
import { chromium } from "playwright"
import { serveVariant } from "../../demo-site/serve.js"
import { observe } from "../../src/observe.js"

const server = await serveVariant("v1")
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(server.url)
const snapshot = await observe(page)
await browser.close()
await server.close()
console.log(JSON.stringify({ nodes: snapshot.nodes.length }))
