import { describe, expect, it } from "vitest"
import { compile, type Trace } from "../src/compile.js"
import { FlowSpecSchema } from "../src/spec.js"
import type { Snapshot, SnapshotNode } from "../src/observe.js"

const node = (over: Partial<SnapshotNode>): SnapshotNode => ({
  idx: 0, role: "button", name: "Export CSV", nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices"], landmarks: ["main"], siblingOrdinal: 1,
  siblingRole: "button", textFingerprint: ["export", "csv"], selector: "#export-btn",
  ...over,
})
const snap = (nodes: SnapshotNode[], url = "http://x/"): Snapshot => ({ url, nodes })

const base: Trace = {
  goal: "export invoices",
  url: "http://x/",
  steps: [
    {
      action: "click", idx: 0,
      urlBefore: "http://x/", urlAfter: "http://x/",
      snapshotBefore: snap([node({})]), snapshotAfter: snap([node({})]),
    },
  ],
}

describe("compile", () => {
  it("produces a spec that parses, which means every healable step has a postcondition", () => {
    expect(() => FlowSpecSchema.parse(compile(base, "invoice-export"))).not.toThrow()
  })

  it("opens with a goto to the trace url", () => {
    const spec = compile(base, "f")
    expect(spec.steps[0]).toMatchObject({ action: "goto", url: "http://x/" })
  })

  it("lifts the anchor verbatim off the snapshot node", () => {
    const step = compile(base, "f").steps[1]
    if (step?.action !== "click") throw new Error("expected click")
    expect(step.target.anchor.nameNormalized).toBe("export csv")
    expect(step.target.anchor.attrs.name).toBe("export")
    expect(step.target.primary).toBe("#export-btn")
  })

  it("generates fallbacks without duplicating the primary", () => {
    const step = compile(base, "f").steps[1]
    if (step?.action !== "click") throw new Error("expected click")
    expect(step.target.fallbacks).toContain('[name="export"]')
    expect(step.target.fallbacks).not.toContain("#export-btn")
  })

  it("infers urlContains when the url changed", () => {
    const trace: Trace = {
      ...base,
      steps: [{ ...base.steps[0]!, urlAfter: "http://x/#/download/ready" }],
    }
    const step = compile(trace, "f").steps[1]
    if (step?.action !== "click") throw new Error("expected click")
    expect(step.postcondition).toEqual({ type: "urlContains", value: "#/download/ready" })
  })

  it("infers selectorVisible when a new element appeared", () => {
    const after = snap([node({}), node({ idx: 1, selector: "#results", name: "Results" })])
    const trace: Trace = { ...base, steps: [{ ...base.steps[0]!, snapshotAfter: after }] }
    const step = compile(trace, "f").steps[1]
    if (step?.action !== "click") throw new Error("expected click")
    expect(step.postcondition).toEqual({ type: "selectorVisible", value: "#results" })
  })

  it("falls back to domChanged rather than omitting a postcondition", () => {
    const step = compile(base, "f").steps[1]
    if (step?.action !== "click") throw new Error("expected click")
    expect(step.postcondition).toEqual({ type: "domChanged" })
  })

  it("turns a fill value into an input placeholder", () => {
    const trace: Trace = {
      ...base,
      steps: [{ ...base.steps[0]!, action: "fill", value: "2026-08", inputName: "month" }],
    }
    const spec = compile(trace, "f")
    const step = spec.steps[1]
    if (step?.action !== "fill") throw new Error("expected fill")
    expect(step.value).toBe("{{month}}")
    expect(spec.inputs.month).toEqual({ type: "string", required: true })
  })
})
