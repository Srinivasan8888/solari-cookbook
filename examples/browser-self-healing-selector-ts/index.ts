/**
 * Self-healing selectors — repair a broken selector instead of failing.
 *
 * A scraper dies when someone renames an id. The element is still there; only
 * the address changed. This asks a model to re-find it from a semantic
 * description captured while the selector still worked.
 *
 * The part worth stealing: a repair is not accepted until a postcondition
 * confirms it. Without that check, a confidently wrong answer reports itself
 * as a success and you silently click the wrong button forever.
 */
import { Solari } from "@solarisdk/browser"

const V1 = `<main><section aria-label="Invoices"><h1>Invoices</h1>
  <button id="export-btn" name="export">Export CSV</button>
  <p id="status">ready</p></section></main>`

// The same page after a redesign: id, name and label all changed.
const V2 = `<main><section aria-label="Invoices"><h1>Invoices</h1>
  <a href="#done" id="cta-dl" name="download" role="button">Download report</a>
  <p id="status">ready</p></section></main>`

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

/** Everything about the element except where it lives. */
const DESCRIBE = `(sel) => {
  const el = document.querySelector(sel)
  return { role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
           name: el.textContent.trim(),
           nearText: [...el.parentElement.children].map((c) => c.textContent.trim()) }
}`

const browser = await solari.launch()
try {
  const page = await browser.newPage()

  await page.setContent(V1)
  const anchor = await page.evaluate(DESCRIBE, "#export-btn")
  console.log("learned  :", JSON.stringify(anchor))

  await page.setContent(V2)
  if ((await page.locator("#export-btn").count()) > 0) throw new Error("expected a break")
  console.log("broken   : #export-btn no longer matches")

  // Candidates carry an index, never a selector, so the model cannot invent
  // one that does not exist on the page.
  const candidates = await page.evaluate(`() =>
    [...document.querySelectorAll("a,button,input")].map((el, idx) => ({
      idx, role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      name: el.textContent.trim(), id: el.id }))`)

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "dots-studio/dots-3-note-preview:free",
      messages: [{ role: "user", content:
        `This element moved:\n${JSON.stringify(anchor)}\n\n` +
        `Current elements:\n${JSON.stringify(candidates)}\n\nWhich idx is the same control?` }],
      response_format: { type: "json_schema", json_schema: { name: "m", strict: true, schema: {
        type: "object", properties: { idx: { type: "integer" } },
        required: ["idx"], additionalProperties: false } } },
    }),
  })
  const { idx } = JSON.parse((await res.json()).choices[0].message.content)
  const repaired = `#${(candidates as { idx: number; id: string }[])[idx]!.id}`
  console.log("repaired :", repaired)

  // The check that makes this safe. A repair you cannot verify is a guess.
  await page.locator(repaired).click()
  const ok = page.url().includes("#done")
  console.log(ok ? "verified : the repaired selector does the same thing" : "REJECTED : postcondition failed")
  if (!ok) process.exitCode = 1
} finally {
  await browser.close()
  // REQUIRED in Node: the client keeps a loopback proxy open for connection
  // retries, and that handle keeps the event loop alive. Skip it and the
  // script prints its output and then hangs forever.
  await solari.close()
}
