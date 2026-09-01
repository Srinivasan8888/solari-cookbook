import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { localBackend } from "../src/backends/local.js"
import { runFlow } from "../src/runtime.js"
import { FlowSpecSchema, loadFlow, type FlowSpec } from "../src/spec.js"

let server: DemoServer

const anchorFor = (over: Record<string, unknown> = {}) => ({
  role: "button", name: "x", nameNormalized: "x",
  attrs: { testId: null, name: null, type: null },
  nearText: [], landmarks: [], siblingOrdinal: 0, siblingRole: "button",
  textFingerprint: [], ...over,
})

function flow(url: string): FlowSpec {
  return FlowSpecSchema.parse({
    name: "invoice-export",
    url,
    inputs: { month: { type: "string", required: true } },
    steps: [
      { id: "s0", action: "goto", url },
      {
        id: "s1", action: "fill", value: "{{month}}",
        target: { primary: "#month", fallbacks: [], anchor: anchorFor({ role: "textbox", siblingRole: "textbox" }) },
        postcondition: { type: "domChanged" },
      },
      {
        id: "s2", action: "click",
        target: { primary: "#load-btn", fallbacks: [], anchor: anchorFor({ name: "Load invoices", nameNormalized: "load invoices" }) },
        postcondition: { type: "selectorVisible", value: "#results" },
      },
      {
        id: "s3", action: "extract", as: "status",
        target: { primary: "#status", fallbacks: [], anchor: anchorFor({ role: "generic", siblingRole: "generic" }) },
        postcondition: { type: "textPresent", value: "results" },
      },
    ],
  })
}

beforeAll(async () => { server = await serveVariant("v1") })
afterAll(async () => { await server.close() })

describe("runFlow", () => {
  it("runs green with zero LLM calls and zero cost", async () => {
    const result = await runFlow(flow(server.url), { month: "2026-08" }, {
      backend: localBackend(),
      healer: null,
    })
    expect(result.status).toBe("ok")
    expect(result.telemetry.llmCalls).toBe(0)
    expect(result.telemetry.costUsd).toBe(0)
    expect(result.output.status).toContain("3 results")
    expect(result.steps.every((s) => s.status === "ok")).toBe(true)
  })

  it("substitutes inputs into step values", async () => {
    const result = await runFlow(flow(server.url), { month: "2026-01" }, {
      backend: localBackend(), healer: null,
    })
    expect(result.output.status).toContain("3 results")
  })

  it("fails loudly, and names the step, when a selector is missing and healing is off", async () => {
    const broken = flow(server.url)
    const step = broken.steps[2]
    if (step?.action !== "click") throw new Error("expected click")
    step.target.primary = "#nope-does-not-exist"

    const result = await runFlow(broken, { month: "2026-08" }, {
      backend: localBackend(), healer: null,
    })
    expect(result.status).toBe("failed")
    expect(result.failure?.stepId).toBe("s2")
    expect(result.telemetry.llmCalls).toBe(0)
  })
})
