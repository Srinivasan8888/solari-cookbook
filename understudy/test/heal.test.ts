import { describe, expect, it } from "vitest"
import { llmHealer } from "../src/heal.js"
import type { LlmClient } from "../src/llm.js"
import type { Snapshot } from "../src/observe.js"
import type { Anchor } from "../src/spec.js"

const anchor: Anchor = {
  role: "button", name: "Export CSV", nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices"], landmarks: ["main"], siblingOrdinal: 1,
  siblingRole: "button", textFingerprint: ["export", "csv"],
}

const snapshot: Snapshot = {
  url: "http://x/",
  nodes: [
    { idx: 0, role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null }, nearText: [], landmarks: ["nav"],
      siblingOrdinal: 0, siblingRole: "link", textFingerprint: ["settings"], selector: "#settings-tab" },
    { idx: 1, role: "button", name: "Download report", nameNormalized: "download report",
      attrs: { testId: null, name: "download", type: "submit" }, nearText: ["Invoices"],
      landmarks: ["main"], siblingOrdinal: 1, siblingRole: "button",
      textFingerprint: ["download", "report"], selector: "#cta-download" },
  ],
}

const stub = (value: unknown): LlmClient => ({
  async complete() {
    return { value, model: "stub", inputTokens: 674, outputTokens: 531, costUsd: 0 } as never
  },
})

describe("llmHealer", () => {
  it("maps the chosen idx back to a selector", async () => {
    const res = await llmHealer(stub({ idx: 1, confidence: 0.9 }))
      .heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(res?.selector).toBe("#cta-download")
    expect(res?.costUsd).toBe(0)
  })

  it("returns null for an idx that is not in the snapshot", async () => {
    const res = await llmHealer(stub({ idx: 42, confidence: 0.9 }))
      .heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(res).toBeNull()
  })

  it("returns null below the confidence floor rather than guessing", async () => {
    const res = await llmHealer(stub({ idx: 1, confidence: 0.1 }))
      .heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(res).toBeNull()
  })

  it("returns null when the chain is exhausted, so the run fails loudly", async () => {
    const throwing: LlmClient = { async complete() { throw new Error("all models failed") } }
    const res = await llmHealer(throwing).heal({ anchor, snapshot, failedSelector: "#x" })
    expect(res).toBeNull()
  })

  it("never puts a selector in the prompt, so the model cannot invent one", async () => {
    let seen = ""
    const spy: LlmClient = {
      async complete(req) {
        seen = req.prompt
        return { value: { idx: 1, confidence: 0.9 }, model: "s", inputTokens: 0, outputTokens: 0, costUsd: 0 } as never
      },
    }
    await llmHealer(spy).heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(seen).not.toContain("#cta-download")
    expect(seen).not.toContain("#settings-tab")
  })
})
