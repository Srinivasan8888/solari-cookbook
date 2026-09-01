/**
 * Trace -> flow artifact. The compiler proper.
 *
 * Pure: no browser, no network, no LLM. The expensive part (deciding what to
 * do) already happened in learn.ts; this turns that decision into a
 * deterministic program, which is the whole thesis of the project.
 */
import type { Snapshot, SnapshotNode } from "./observe.js"
import {
  FlowSpecSchema,
  type Anchor,
  type FlowSpec,
  type Postcondition,
  type Step,
} from "./spec.js"

export type TraceStep = {
  action: "click" | "fill" | "select" | "extract"
  /** Index into snapshotBefore.nodes. */
  idx: number
  value?: string
  /** For fill/select: the flow input this value came from. */
  inputName?: string
  /** For extract: the output key. */
  as?: string
  urlBefore: string
  urlAfter: string
  snapshotBefore: Snapshot
  snapshotAfter: Snapshot
}

export type Trace = {
  goal: string
  url: string
  steps: TraceStep[]
}

function anchorOf(node: SnapshotNode): Anchor {
  return {
    role: node.role,
    name: node.name,
    nameNormalized: node.nameNormalized,
    attrs: node.attrs,
    nearText: node.nearText,
    landmarks: node.landmarks,
    siblingOrdinal: node.siblingOrdinal,
    siblingRole: node.siblingRole,
    textFingerprint: node.textFingerprint,
  }
}

/**
 * Cheap alternatives to try before any scoring or model call. Ordered most
 * to least stable; the primary is excluded so the ladder never retries the
 * selector that just failed.
 */
function fallbacksFor(node: SnapshotNode): string[] {
  const out: string[] = []
  if (node.attrs.testId) out.push(`[data-testid="${node.attrs.testId}"]`)
  if (node.attrs.name) out.push(`[name="${node.attrs.name}"]`)
  if (node.name) {
    out.push(`role=${node.role}[name="${node.name}"]`)
    out.push(`text=${node.name}`)
  }
  return [...new Set(out)].filter((s) => s !== node.selector)
}

/**
 * What observable thing proves this step worked?
 *
 * Ordered by strength. `domChanged` is the floor, never omission: StepSchema
 * refuses to parse a healable step without a postcondition, because a repair
 * with nothing to verify against is a guess that reports itself as success.
 */
function postconditionFor(step: TraceStep, node: SnapshotNode): Postcondition {
  // `extract` reads; it changes nothing. Inferring domChanged for it would
  // produce a step that can never pass. What a read step can assert is that
  // the thing it read was actually present.
  if (step.action === "extract") {
    return { type: "selectorVisible", value: node.selector }
  }

  if (step.urlAfter !== step.urlBefore) {
    const before = step.urlBefore
    const after = step.urlAfter
    // The part of the new URL that is genuinely new.
    let i = 0
    while (i < before.length && i < after.length && before[i] === after[i]) i++
    const suffix = after.slice(i)
    if (suffix) return { type: "urlContains", value: suffix }
  }

  const seen = new Set(step.snapshotBefore.nodes.map((n) => n.selector))
  const appeared = step.snapshotAfter.nodes.find((n) => !seen.has(n.selector))
  if (appeared) return { type: "selectorVisible", value: appeared.selector }

  return { type: "domChanged" }
}

export function compile(trace: Trace, name: string): FlowSpec {
  const inputs: Record<string, { type: "string"; required: boolean }> = {}
  const steps: Step[] = [{ id: "s0", action: "goto", url: trace.url }]

  trace.steps.forEach((traceStep, i) => {
    const node = traceStep.snapshotBefore.nodes.find((n) => n.idx === traceStep.idx)
    if (!node) throw new Error(`trace step ${i} references idx ${traceStep.idx}, not in its snapshot`)

    const target = {
      primary: node.selector,
      fallbacks: fallbacksFor(node),
      anchor: anchorOf(node),
      history: [],
    }
    const id = `s${i + 1}`
    const postcondition = postconditionFor(traceStep, node)

    switch (traceStep.action) {
      case "click":
        steps.push({ id, action: "click", target, postcondition })
        break
      case "fill":
      case "select": {
        // A literal typed during learning becomes a flow input, so the
        // artifact is a parameterised program rather than a recording.
        let value = traceStep.value ?? ""
        if (traceStep.inputName) {
          inputs[traceStep.inputName] = { type: "string", required: true }
          value = `{{${traceStep.inputName}}}`
        }
        steps.push({ id, action: traceStep.action, target, value, postcondition })
        break
      }
      case "extract":
        steps.push({
          id, action: "extract", target,
          as: traceStep.as ?? `out${i}`,
          postcondition,
        })
        break
    }
  })

  return FlowSpecSchema.parse({ name, url: trace.url, inputs, steps })
}
