import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FlowSpecSchema, StepSchema, loadFlow, saveFlow, recordRepair } from "../src/spec.js"

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

describe("loadFlow / saveFlow", () => {
  it("round-trips a flow through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-"))
    const path = join(dir, "demo.json")
    const flow = FlowSpecSchema.parse({
      name: "demo",
      url: "https://example.com",
      steps: [{ id: "s0", action: "goto", url: "https://example.com" }],
    })
    saveFlow(path, flow)
    expect(loadFlow(path)).toEqual(flow)
  })
})

describe("recordRepair", () => {
  it("bumps version, swaps the selector, and appends history", () => {
    const flow = FlowSpecSchema.parse({
      name: "demo",
      url: "https://example.com",
      steps: [
        { id: "s0", action: "goto", url: "https://example.com" },
        { id: "s1", action: "click", target, postcondition: { type: "domChanged" } },
      ],
    })

    const next = recordRepair(flow, "s1", {
      at: "2026-09-01T00:00:00.000Z",
      from: "#export-btn",
      to: "#btn-export",
      tier: "anchor",
      costUsd: 0,
      replayUrl: null,
    })

    expect(next.version).toBe(2)
    const step = next.steps[1]
    if (step?.action !== "click") throw new Error("expected click step")
    expect(step.target.primary).toBe("#btn-export")
    expect(step.target.fallbacks).toContain("#export-btn")
    expect(step.target.history).toHaveLength(1)

    // The original must be untouched.
    const original = flow.steps[1]
    if (original?.action !== "click") throw new Error("expected click step")
    expect(original.target.primary).toBe("#export-btn")
  })
})
