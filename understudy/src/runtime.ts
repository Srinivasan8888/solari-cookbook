// NOTE: this module must never import an LLM client, directly or transitively.
// Enforced by test/isolation.test.ts. Repair arrives through the injected
// Healer interface, which is null unless the caller opts in -- so a run that
// does not heal *cannot* make an LLM call, because the code path is absent.
import type { Page } from "playwright"
import {
  isHealable,
  recordRepair,
  type FlowSpec,
  type Postcondition,
  type Step,
  type Target,
} from "./spec.js"
import { observe } from "./observe.js"
import { rankCandidates } from "./anchor.js"
import { emptyTelemetry, type Telemetry } from "./cost.js"
import type { Backend, Healer } from "./backends/types.js"

export type StepOutcome = {
  stepId: string
  status: "ok" | "healed" | "failed"
  ms: number
  selectorUsed: string | null
  tier?: "fallback" | "anchor" | "llm"
}

export type RunResult = {
  flow: string
  version: number
  status: "ok" | "failed"
  telemetry: Telemetry
  steps: StepOutcome[]
  output: Record<string, string>
  failure?: { stepId: string; reason: string }
  /** Present when a repair happened; the caller decides whether to persist it. */
  repaired?: FlowSpec
}

export type RunOptions = {
  backend: Backend
  healer: Healer | null
  stepTimeoutMs?: number
}

function interpolate(value: string, inputs: Record<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => inputs[key] ?? "")
}

/**
 * Serialized HTML plus live form state. `page.content()` alone misses a fill:
 * setting an input's value changes the property, not the attribute, so the
 * markup is byte-identical afterwards. Form values are observable state and
 * belong in the fingerprint.
 */
async function domFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const values = Array.from(
      document.querySelectorAll("input, textarea, select"),
    )
      .map((el) => (el as HTMLInputElement).value)
      .join("\u0001")
    return `${document.documentElement.outerHTML}\u0000${values}`
  })
}

async function checkPostcondition(
  page: Page,
  post: Postcondition,
  before: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    switch (post.type) {
      case "urlContains":
        await page.waitForURL((u) => u.toString().includes(post.value), { timeout: timeoutMs })
        return true
      case "selectorVisible":
        await page.locator(post.value).first().waitFor({ state: "visible", timeout: timeoutMs })
        return true
      case "textPresent":
        await page
          .getByText(post.value, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: timeoutMs })
        return true
      case "domChanged": {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if ((await domFingerprint(page)) !== before) return true
          await page.waitForTimeout(50)
        }
        return false
      }
    }
  } catch {
    return false
  }
}

async function actOn(
  page: Page,
  step: Step,
  selector: string,
  inputs: Record<string, string>,
  timeoutMs: number,
): Promise<string | null> {
  const locator = page.locator(selector).first()
  switch (step.action) {
    case "click":
      await locator.click({ timeout: timeoutMs })
      return null
    case "fill":
      await locator.fill(interpolate(step.value, inputs), { timeout: timeoutMs })
      return null
    case "select":
      await locator.selectOption(interpolate(step.value, inputs), { timeout: timeoutMs })
      return null
    case "waitFor":
      await locator.waitFor({ state: "visible", timeout: timeoutMs })
      return null
    case "extract":
      await locator.waitFor({ state: "attached", timeout: timeoutMs })
      return (await locator.innerText()).trim()
    default:
      return null
  }
}

type Repair = { selector: string; tier: "fallback" | "anchor" | "llm"; costUsd: number }

/** fallbacks -> anchor scoring -> LLM. The first two rungs are free. */
async function repair(
  page: Page,
  target: Target,
  healer: Healer | null,
  telemetry: Telemetry,
): Promise<Repair | null> {
  for (const candidate of target.fallbacks) {
    if ((await page.locator(candidate).first().count()) > 0) {
      return { selector: candidate, tier: "fallback", costUsd: 0 }
    }
  }

  const snapshot = await observe(page)
  const { accepted } = rankCandidates(target.anchor, snapshot)
  if (accepted) return { selector: accepted.selector, tier: "anchor", costUsd: 0 }

  if (!healer) return null

  const started = Date.now()
  const healed = await healer.heal({
    anchor: target.anchor,
    snapshot,
    failedSelector: target.primary,
  })
  // Prefer the healer's own reported latency: under a cassette the wall clock
  // measures reading a file, and a benchmark that reported 2ms for a call that
  // really took 6s would be worse than no benchmark.
  telemetry.healMs += healed?.ms ?? Date.now() - started
  if (!healed) return null

  telemetry.llmCalls += 1
  telemetry.costUsd += healed.costUsd
  telemetry.inputTokens += healed.inputTokens
  telemetry.outputTokens += healed.outputTokens
  // This repair's own cost, not the run's running total.
  return { selector: healed.selector, tier: "llm", costUsd: healed.costUsd }
}

export async function runFlow(
  flow: FlowSpec,
  inputs: Record<string, string>,
  opts: RunOptions,
): Promise<RunResult> {
  const timeoutMs = opts.stepTimeoutMs ?? 5_000
  const telemetry = emptyTelemetry()
  const steps: StepOutcome[] = []
  const output: Record<string, string> = {}
  let current = flow
  const session = await opts.backend.open({ profile: flow.profile })
  const startedAll = Date.now()
  // Wall time actually spent repairing, which is NOT telemetry.healMs.
  // healMs reports the model call's own latency and is preserved through
  // cassettes, so under replay it is a recorded 9s while the wall clock is
  // milliseconds. Subtracting one from the other produced negative replay
  // times. Two different quantities; keep them apart.
  let healWallMs = 0

  try {
    for (const step of current.steps) {
      const startedStep = Date.now()

      if (step.action === "goto") {
        await session.page.goto(step.url, { timeout: timeoutMs * 2 })
        steps.push({
          stepId: step.id, status: "ok",
          ms: Date.now() - startedStep, selectorUsed: null,
        })
        continue
      }

      if (step.action === "assert") {
        const ok = await checkPostcondition(session.page, step.postcondition, "", timeoutMs)
        steps.push({
          stepId: step.id, status: ok ? "ok" : "failed",
          ms: Date.now() - startedStep, selectorUsed: null,
        })
        if (!ok) {
          telemetry.replayMs = Date.now() - startedAll
          return {
            flow: current.name, version: current.version, status: "failed",
            telemetry, steps, output,
            failure: { stepId: step.id, reason: "assertion failed" },
          }
        }
        continue
      }

      if (!isHealable(step)) continue

      const before = await domFingerprint(session.page)
      let selector = step.target.primary
      let tier: StepOutcome["tier"]
      let extracted: string | null = null
      let ok = false

      try {
        extracted = await actOn(session.page, step, selector, inputs, timeoutMs)
        ok = await checkPostcondition(session.page, step.postcondition, before, timeoutMs)
      } catch {
        ok = false
      }

      if (!ok) {
        const healStarted = Date.now()
        const fix = await repair(session.page, step.target, opts.healer, telemetry)
        healWallMs += Date.now() - healStarted
        if (fix) {
          try {
            extracted = await actOn(session.page, step, fix.selector, inputs, timeoutMs)
            // A heal is not accepted until the postcondition confirms it.
            ok = await checkPostcondition(session.page, step.postcondition, before, timeoutMs)
          } catch {
            ok = false
          }
          if (ok) {
            selector = fix.selector
            tier = fix.tier
            current = recordRepair(current, step.id, {
              at: new Date().toISOString(),
              from: step.target.primary,
              to: fix.selector,
              tier: fix.tier,
              costUsd: fix.costUsd,
              replayUrl: await session.replayUrl(),
              sessionId: session.sessionId,
            })
          }
        }
      }

      steps.push({
        stepId: step.id,
        status: ok ? (tier ? "healed" : "ok") : "failed",
        ms: Date.now() - startedStep,
        selectorUsed: ok ? selector : null,
        tier,
      })

      if (!ok) {
        telemetry.replayMs = Date.now() - startedAll - healWallMs
        return {
          flow: current.name, version: current.version, status: "failed",
          telemetry, steps, output,
          failure: { stepId: step.id, reason: `no working selector for ${step.target.primary}` },
        }
      }

      if (step.action === "extract" && extracted !== null) output[step.as] = extracted
    }

    telemetry.replayMs = Date.now() - startedAll - healWallMs
    return {
      flow: current.name, version: current.version, status: "ok",
      telemetry, steps, output,
      ...(current.version !== flow.version ? { repaired: current } : {}),
    }
  } finally {
    await session.close()
  }
}
