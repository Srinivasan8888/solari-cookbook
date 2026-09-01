import { describe, expect, it } from "vitest"
import { FlowSpecSchema, StepSchema } from "../src/spec.js"

const anchor = {
  role: "button",
  name: "Export CSV",
  nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices"],
  landmarks: ["main"],
  siblingOrdinal: 2,
  siblingRole: "button",
  textFingerprint: ["export", "csv"],
}

const target = { primary: "#export-btn", fallbacks: [], anchor }

describe("StepSchema", () => {
  it("accepts a click step that has a postcondition", () => {
    const step = {
      id: "s1",
      action: "click",
      target,
      postcondition: { type: "urlContains", value: "/download" },
    }
    expect(StepSchema.parse(step)).toMatchObject({ id: "s1", action: "click" })
  })

  it("REJECTS a click step with no postcondition", () => {
    const step = { id: "s1", action: "click", target }
    expect(() => StepSchema.parse(step)).toThrow()
  })

  it("accepts a goto step, which is not healable and needs no postcondition", () => {
    const step = { id: "s0", action: "goto", url: "https://example.com" }
    expect(StepSchema.parse(step)).toMatchObject({ action: "goto" })
  })
})

describe("FlowSpecSchema", () => {
  it("defaults version to 1 and backend to local", () => {
    const flow = FlowSpecSchema.parse({
      name: "demo",
      url: "https://example.com",
      steps: [{ id: "s0", action: "goto", url: "https://example.com" }],
    })
    expect(flow.version).toBe(1)
    expect(flow.backend).toBe("local")
  })
})
