import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser, type Page } from "playwright"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { observe } from "../src/observe.js"

let server: DemoServer
let browser: Browser
let page: Page

beforeAll(async () => {
  server = await serveVariant("v1")
  browser = await chromium.launch()
  page = await browser.newPage()
  await page.goto(server.url)
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

describe("observe", () => {
  it("finds the export button with role, name and attributes", async () => {
    const snapshot = await observe(page)
    const node = snapshot.nodes.find((n) => n.name === "Export CSV")
    expect(node).toBeDefined()
    expect(node!.role).toBe("button")
    expect(node!.nameNormalized).toBe("export csv")
    expect(node!.attrs.name).toBe("export")
    expect(node!.selector).toBe("#export-btn")
  })

  it("labels the month input from its <label for>", async () => {
    const snapshot = await observe(page)
    const node = snapshot.nodes.find((n) => n.selector === "#month")
    expect(node!.role).toBe("textbox")
    expect(node!.name).toBe("Billing month")
  })

  it("records landmarks and sibling ordinals", async () => {
    const snapshot = await observe(page)
    const node = snapshot.nodes.find((n) => n.name === "Export CSV")!
    expect(node.landmarks.join(" ")).toContain("section")
    expect(node.siblingRole).toBe("button")
    expect(node.siblingOrdinal).toBe(1) // second button in its parent
  })

  it("stays small enough to be cheap", async () => {
    const snapshot = await observe(page)
    expect(snapshot.nodes.length).toBeLessThanOrEqual(120)
    expect(JSON.stringify(snapshot).length).toBeLessThan(6000)
  })
})
