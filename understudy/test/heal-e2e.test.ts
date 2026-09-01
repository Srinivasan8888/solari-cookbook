import { describe, expect, it } from "vitest"
import { chromium } from "playwright"
import { join } from "node:path"
import { serveVariant } from "../demo-site/serve.js"
import { observe } from "../src/observe.js"
import { rankCandidates } from "../src/anchor.js"
import { runFlow } from "../src/runtime.js"
import { localBackend } from "../src/backends/local.js"
import { llmHealer } from "../src/heal.js"
import { cassetteClient } from "../src/cassette.js"
import { openRouterClient } from "../src/llm.js"
import { FlowSpecSchema, type Anchor, type FlowSpec } from "../src/spec.js"

const CASSETTE = join(import.meta.dirname, "..", "fixtures", "cassettes", "heal-redesign.json")
const MODE = (process.env.UNDERSTUDY_CASSETTE ?? "replay") as "record" | "replay" | "off"

const MODELS = [
  "dots-studio/dots-3-note-preview:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
]

function healer() {
  const live = openRouterClient({ apiKey: process.env.OPENROUTER_API_KEY ?? "", models: MODELS })
  return llmHealer(cassetteClient(live, { mode: MODE, path: CASSETTE }))
}

/** Capture the export button's anchor from v1, exactly as the compiler would. */
async function anchorFromV1(): Promise<Anchor> {
  const v1 = await serveVariant("v1")
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(v1.url)
  const snap = await observe(page)
  await browser.close()
  await v1.close()
  const n = snap.nodes.find((x) => x.selector === "#export-btn")!
  return {
    role: n.role, name: n.name, nameNormalized: n.nameNormalized, attrs: n.attrs,
    nearText: n.nearText, landmarks: n.landmarks, siblingOrdinal: n.siblingOrdinal,
    siblingRole: n.siblingRole, textFingerprint: n.textFingerprint,
  }
}

function flowWith(url: string, exportAnchor: Anchor): FlowSpec {
  const plain = (over: Partial<Anchor> = {}): Anchor => ({
    role: "button", name: "x", nameNormalized: "x",
    attrs: { testId: null, name: null, type: null },
    nearText: [], landmarks: [], siblingOrdinal: 0, siblingRole: "button",
    textFingerprint: [], ...over,
  })
  return FlowSpecSchema.parse({
    name: "invoice-export", url,
    inputs: { month: { type: "string", required: true } },
    steps: [
      { id: "s0", action: "goto", url },
      { id: "s1", action: "fill", value: "{{month}}",
        target: { primary: "#month", fallbacks: [], anchor: plain({ role: "textbox", siblingRole: "textbox" }) },
        postcondition: { type: "domChanged" } },
      { id: "s2", action: "click",
        target: { primary: "#load-btn", fallbacks: [], anchor: plain() },
        postcondition: { type: "selectorVisible", value: "#results" } },
      // v2-redesign changes this button's id, label AND name attribute.
      { id: "s3", action: "click",
        target: { primary: "#export-btn", fallbacks: [], anchor: exportAnchor },
        postcondition: { type: "urlContains", value: "/download" } },
    ],
  })
}

describe("paid repair tier", () => {
  it("free scoring correctly refuses the redesign", async () => {
    const anchor = await anchorFromV1()
    const v2 = await serveVariant("v2-redesign")
    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(v2.url)
    const snap = await observe(page)
    await browser.close()
    await v2.close()

    const ranked = rankCandidates(anchor, snap)
    expect(ranked.accepted).toBeNull()                       // declines to guess
    expect(ranked.ranked[0]!.node.selector).toBe("#cta-download") // but ranks it first
    expect(ranked.ranked[0]!.score).toBeLessThan(0.8)
  })

  it("heals it with exactly one LLM call, verified by the postcondition", async () => {
    const anchor = await anchorFromV1()
    const v2 = await serveVariant("v2-redesign")
    try {
      const result = await runFlow(flowWith(v2.url, anchor), { month: "2026-08" }, {
        backend: localBackend(),
        healer: healer(),
      })

      expect(result.status).toBe("ok")
      expect(result.telemetry.llmCalls).toBe(1)

      const healed = result.steps.find((s) => s.stepId === "s3")
      expect(healed?.status).toBe("healed")
      expect(healed?.tier).toBe("llm")
      expect(healed?.selectorUsed).toBe("#cta-download")

      // The repair is recorded, auditable, and demotes the old selector.
      const step = result.repaired?.steps[3]
      if (step?.action !== "click") throw new Error("expected click")
      expect(step.target.history).toHaveLength(1)
      expect(step.target.history[0]!.tier).toBe("llm")
      expect(step.target.fallbacks).toContain("#export-btn")
    } finally {
      await v2.close()
    }
  }, 120_000)
})
