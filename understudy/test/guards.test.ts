import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { localBackend } from "../src/backends/local.js"
import { learn } from "../src/learn.js"
import { runFlow } from "../src/runtime.js"
import { FlowSpecSchema } from "../src/spec.js"
import type { LlmClient } from "../src/llm.js"
import type { Healer } from "../src/backends/types.js"

let server: DemoServer
beforeAll(async () => { server = await serveVariant("v1") })
afterAll(async () => { await server.close() })

/** Always acts, never finishes, and charges for it. */
const expensive: LlmClient = {
  async complete() {
    return {
      value: { done: false, reasoning: "again", action: "click", idx: 0, value: "", inputName: "", as: "" },
      model: "pricey", inputTokens: 100, outputTokens: 100, costUsd: 1.0,
    } as never
  },
}

describe("guards", () => {
  it("aborts before the call that would breach the spend limit", async () => {
    await expect(
      learn({
        goal: "burn money", url: server.url, name: "x",
        llm: expensive, backend: localBackend(),
        maxTurns: 50, maxSpendUsd: 1.5,
      }),
    ).rejects.toThrow(/spend guard/)
  }, 120_000)

  it("rejects a heal the postcondition cannot confirm, and fails loudly", async () => {
    // A healer that returns a real element -- just the wrong one. This is the
    // failure mode that matters: a confident wrong answer. Without postcondition
    // verification the run would report success having clicked the wrong thing.
    const liar: Healer = {
      async heal() {
        return { selector: "#settings-tab", costUsd: 0 }
      },
    }
    const spec = FlowSpecSchema.parse({
      name: "liar-test", url: server.url,
      steps: [
        { id: "s0", action: "goto", url: server.url },
        {
          id: "s1", action: "click",
          target: {
            primary: "#does-not-exist", fallbacks: [],
            anchor: {
              role: "button", name: "Load invoices", nameNormalized: "load invoices",
              attrs: { testId: null, name: "load", type: "button" },
              nearText: [], landmarks: [], siblingOrdinal: 0, siblingRole: "button",
              textFingerprint: ["load"],
            },
          },
          postcondition: { type: "selectorVisible", value: "#results" },
        },
      ],
    })

    const result = await runFlow(spec, {}, { backend: localBackend(), healer: liar })
    expect(result.status).toBe("failed")
    expect(result.failure?.stepId).toBe("s1")
    // It escalated once and stopped. No second agentic attempt.
    expect(result.telemetry.llmCalls).toBe(1)
  }, 120_000)
})
