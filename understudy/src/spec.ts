import { z } from "zod"

export const AnchorSchema = z.object({
  role: z.string(),
  name: z.string(),
  nameNormalized: z.string(),
  attrs: z.object({
    testId: z.string().nullable(),
    name: z.string().nullable(),
    type: z.string().nullable(),
  }),
  nearText: z.array(z.string()),
  landmarks: z.array(z.string()),
  siblingOrdinal: z.number().int(),
  siblingRole: z.string(),
  textFingerprint: z.array(z.string()),
})
export type Anchor = z.infer<typeof AnchorSchema>

export const HistoryEntrySchema = z.object({
  at: z.string(),
  from: z.string(),
  to: z.string(),
  tier: z.enum(["fallback", "anchor", "llm"]),
  costUsd: z.number(),
  replayUrl: z.string().nullable(),
})
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

export const TargetSchema = z.object({
  primary: z.string(),
  fallbacks: z.array(z.string()).default([]),
  anchor: AnchorSchema,
  history: z.array(HistoryEntrySchema).default([]),
})
export type Target = z.infer<typeof TargetSchema>

export const PostconditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("urlContains"), value: z.string() }),
  z.object({ type: z.literal("selectorVisible"), value: z.string() }),
  z.object({ type: z.literal("textPresent"), value: z.string() }),
  z.object({ type: z.literal("domChanged") }),
])
export type Postcondition = z.infer<typeof PostconditionSchema>

// Healable variants require a postcondition. A heal with nothing to verify
// against is a guess that reports itself as a success.
export const StepSchema = z.discriminatedUnion("action", [
  z.object({ id: z.string(), action: z.literal("goto"), url: z.string() }),
  z.object({
    id: z.string(), action: z.literal("click"),
    target: TargetSchema, postcondition: PostconditionSchema,
  }),
  z.object({
    id: z.string(), action: z.literal("fill"),
    target: TargetSchema, value: z.string(), postcondition: PostconditionSchema,
  }),
  z.object({
    id: z.string(), action: z.literal("select"),
    target: TargetSchema, value: z.string(), postcondition: PostconditionSchema,
  }),
  z.object({
    id: z.string(), action: z.literal("waitFor"),
    target: TargetSchema, postcondition: PostconditionSchema,
  }),
  z.object({
    id: z.string(), action: z.literal("extract"),
    target: TargetSchema, as: z.string(), postcondition: PostconditionSchema,
  }),
  z.object({ id: z.string(), action: z.literal("assert"), postcondition: PostconditionSchema }),
])
export type Step = z.infer<typeof StepSchema>

export const FlowSpecSchema = z.object({
  name: z.string(),
  version: z.number().int().default(1),
  url: z.string(),
  backend: z.enum(["local", "solari"]).default("local"),
  profile: z.string().nullable().default(null),
  inputs: z.record(z.string(), z.object({
    type: z.literal("string"),
    required: z.boolean().default(true),
  })).default({}),
  steps: z.array(StepSchema),
})
export type FlowSpec = z.infer<typeof FlowSpecSchema>

/** Steps whose target can be repaired. `goto` and `assert` have no target. */
export function isHealable(step: Step): step is Extract<Step, { target: Target }> {
  return step.action !== "goto" && step.action !== "assert"
}

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export function loadFlow(path: string): FlowSpec {
  return FlowSpecSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function saveFlow(path: string, flow: FlowSpec): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(flow, null, 2) + "\n", "utf8")
}

/**
 * Apply a repair immutably. The old selector is demoted to a fallback rather
 * than discarded: sites revert, and a demoted selector costs nothing to try.
 */
export function recordRepair(
  flow: FlowSpec,
  stepId: string,
  entry: HistoryEntry,
): FlowSpec {
  const steps = flow.steps.map((step) => {
    if (step.id !== stepId || !isHealable(step)) return step
    const fallbacks = [entry.from, ...step.target.fallbacks].filter(
      (s, i, all) => s !== entry.to && all.indexOf(s) === i,
    )
    return {
      ...step,
      target: {
        ...step.target,
        primary: entry.to,
        fallbacks,
        history: [...step.target.history, entry],
      },
    }
  })
  return { ...flow, version: flow.version + 1, steps }
}
