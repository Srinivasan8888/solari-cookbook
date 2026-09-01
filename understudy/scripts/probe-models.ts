/**
 * Picks the heal model on evidence rather than vibes.
 *
 * Builds the genuinely hard case -- a redesign that changes id, label and name
 * attribute at once, dropping free anchor scoring below its accept threshold --
 * and races candidate models on it. Run: npm run probe
 */
import { chromium } from "playwright"
import { serveVariant } from "../demo-site/serve.js"
import { observe } from "../src/observe.js"
import { rankCandidates, scoreCandidate } from "../src/anchor.js"
import type { Anchor } from "../src/spec.js"

const KEY = process.env.OPENROUTER_API_KEY!
const MODELS = [
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "dots-studio/dots-3-note-preview:free",
  "liquid/lfm-2.5-2.6b:free",
]

const browser = await chromium.launch()
const page = await browser.newPage()

// 1. Capture the anchor from v1, exactly as the compiler would.
const v1 = await serveVariant("v1")
await page.goto(v1.url)
const s1 = await observe(page)
const src = s1.nodes.find((n) => n.selector === "#export-btn")!
const anchor: Anchor = {
  role: src.role, name: src.name, nameNormalized: src.nameNormalized,
  attrs: src.attrs, nearText: src.nearText, landmarks: src.landmarks,
  siblingOrdinal: src.siblingOrdinal, siblingRole: src.siblingRole,
  textFingerprint: src.textFingerprint,
}
await v1.close()

// 2. Snapshot the redesigned page.
const v2 = await serveVariant("v2-redesign")
await page.goto(v2.url)
const s2 = await observe(page)
await v2.close()
await browser.close()

const TRUTH = "#cta-download"
const ranked = rankCandidates(anchor, s2)
console.log(`anchor: ${anchor.role} "${anchor.name}" name=${anchor.attrs.name}`)
console.log(`free tier top: ${ranked.ranked[0]!.node.selector} @ ${ranked.ranked[0]!.score.toFixed(3)}`)
console.log(`free tier accepted: ${ranked.accepted?.selector ?? "NONE -> escalates to LLM"}`)
console.log(`truth score: ${scoreCandidate(anchor, s2.nodes.find(n=>n.selector===TRUTH)!).toFixed(3)}`)
console.log(`snapshot: ${s2.nodes.length} nodes, ${JSON.stringify(s2).length} bytes\n`)

const schema = {
  type: "object",
  properties: {
    idx: { type: "integer", description: "idx of the matching element" },
    confidence: { type: "number" },
  },
  required: ["idx", "confidence"],
  additionalProperties: false,
}

const prompt = `A recorded UI step targeted this element, described semantically:
${JSON.stringify(anchor, null, 2)}

The page has since changed. These are the interactive elements now present:
${JSON.stringify(s2.nodes.map((n) => ({ idx: n.idx, role: n.role, name: n.name, attrs: n.attrs, nearText: n.nearText })), null, 2)}

Return the idx of the element that is the same UI affordance as the original.`

for (const model of MODELS) {
  const t0 = Date.now()
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "match", strict: true, schema } },
        max_tokens: 2000,
      }),
    })
    const j: any = await res.json()
    const ms = Date.now() - t0
    if (!res.ok || j.error) { console.log(`${model.padEnd(45)} ERROR ${j.error?.message ?? res.status}`); continue }
    const parsed = JSON.parse(j.choices[0].message.content)
    const picked = s2.nodes.find((n) => n.idx === parsed.idx)
    const ok = picked?.selector === TRUTH
    const u = j.usage ?? {}
    console.log(
      `${model.padEnd(45)} ${ok ? "PASS" : "FAIL"}  ${String(ms).padStart(6)}ms  ` +
      `picked=${picked?.selector ?? "?"}  tok=${u.prompt_tokens ?? "?"}/${u.completion_tokens ?? "?"}`,
    )
  } catch (e: any) {
    console.log(`${model.padEnd(45)} THREW ${e.message?.slice(0, 60)}`)
  }
}
