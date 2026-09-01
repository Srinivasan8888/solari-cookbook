import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { localBackend } from "../src/backends/local.js"
import { learn } from "../src/learn.js"
import { runFlow } from "../src/runtime.js"
import type { LlmClient } from "../src/llm.js"

let server: DemoServer
beforeAll(async () => { server = await serveVariant("v1") })
afterAll(async () => { await server.close() })

type El = { idx: number; role: string; name: string }

/** Reads the element list back out of the prompt and picks by name, the way
 *  a real model would -- so the test exercises the real prompt format. */
function scripted(pick: (els: El[], turn: number) => object): LlmClient {
  let turn = 0
  return {
    async complete() {
      const value = pick(lastElements, turn++)
      return { value, model: "scripted", inputTokens: 0, outputTokens: 0, costUsd: 0 } as never
    },
  }
}
let lastElements: El[] = []

function capturing(inner: LlmClient): LlmClient {
  return {
    async complete(req) {
      const m = req.prompt.match(/ELEMENTS:\n(\[[\s\S]*?\])\n/)
      lastElements = m ? (JSON.parse(m[1]!) as El[]) : []
      return inner.complete(req)
    },
  }
}

const byName = (els: El[], name: string) =>
  els.find((e) => e.name.toLowerCase().includes(name.toLowerCase()))?.idx ?? -1

describe("learn", () => {
  it("compiles a goal into a spec that actually runs green", async () => {
    const llm = capturing(
      scripted((els, turn) => {
        if (turn === 0)
          return { done: false, reasoning: "enter the month", action: "fill",
                   idx: byName(els, "Billing month"), value: "2026-08", inputName: "month", as: "" }
        if (turn === 1)
          return { done: false, reasoning: "load them", action: "click",
                   idx: byName(els, "Load invoices"), value: "", inputName: "", as: "" }
        if (turn === 2)
          return { done: false, reasoning: "read the count", action: "extract",
                   idx: byName(els, "results"), value: "", inputName: "", as: "status" }
        return { done: true, reasoning: "goal met", action: "none", idx: -1, value: "", inputName: "", as: "" }
      }),
    )

    const { spec, telemetry } = await learn({
      goal: "export the invoices for a month",
      url: server.url,
      name: "invoice-export",
      llm,
      backend: localBackend(),
    })

    expect(spec.steps.length).toBeGreaterThanOrEqual(4)
    expect(spec.inputs.month).toEqual({ type: "string", required: true })
    expect(telemetry.llmCalls).toBeGreaterThan(0)

    // The only assertion that matters: the compiler's output is executable,
    // deterministically, with no model involved.
    const result = await runFlow(spec, { month: "2026-08" }, {
      backend: localBackend(), healer: null,
    })
    expect(result.status).toBe("ok")
    expect(result.telemetry.llmCalls).toBe(0)
    expect(result.output.status).toContain("3 results")
  }, 120_000)

  it("stops at maxTurns instead of looping forever", async () => {
    const never = capturing(
      scripted((els) => ({ done: false, reasoning: "again", action: "click",
                           idx: byName(els, "Dashboard"), value: "", inputName: "", as: "" })),
    )
    const { trace } = await learn({
      goal: "never finish", url: server.url, name: "x",
      llm: never, backend: localBackend(), maxTurns: 3,
    })
    expect(trace.steps).toHaveLength(3)
  }, 120_000)
})
