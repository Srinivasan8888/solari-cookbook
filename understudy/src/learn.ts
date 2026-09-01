/**
 * The compiler's front end: drive the page once, expensively, and record what
 * was done. compile.ts turns that trace into a deterministic program.
 *
 * One strict-JSON action per turn -- deliberately NOT native tool-calling.
 * Probing four free OpenRouter models showed tool-calling handled
 * inconsistently, while a strict JSON schema is widely supported and
 * deterministic to cassette.
 */
import type { Page } from "playwright"
import { compile, type Trace, type TraceStep } from "./compile.js"
import { observe, type Snapshot } from "./observe.js"
import { emptyTelemetry, type Telemetry } from "./cost.js"
import type { Backend } from "./backends/types.js"
import type { LlmClient } from "./llm.js"
import type { FlowSpec } from "./spec.js"

export const DEFAULT_MAX_TURNS = 25
export const DEFAULT_MAX_SPEND_USD = 2.0

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean", description: "true when the goal is achieved" },
    reasoning: { type: "string", description: "one sentence" },
    action: { type: "string", enum: ["click", "fill", "select", "extract", "none"] },
    idx: { type: "integer", description: "idx of the target element, -1 when done" },
    value: { type: "string", description: "text to type, else empty" },
    inputName: { type: "string", description: "name this value as a flow input, else empty" },
    as: { type: "string", description: "output key for extract, else empty" },
  },
  // Every property is required: strict JSON schema support across providers is
  // far more reliable when nothing is optional. Unused fields carry "" or -1.
  required: ["done", "reasoning", "action", "idx", "value", "inputName", "as"],
  additionalProperties: false,
}

type Action = {
  done: boolean
  reasoning: string
  action: "click" | "fill" | "select" | "extract" | "none"
  idx: number
  value: string
  inputName: string
  as: string
}

const SYSTEM = [
  "You are driving a web page to accomplish a goal, one action at a time.",
  "You see only the page's interactive and text elements, each with an idx.",
  "Choose the single next action. Set done=true when the goal is achieved.",
  "When you type a value that a future run should vary (a date, an id, a search",
  "term), set inputName so it becomes a parameter of the compiled flow.",
].join(" ")

export function buildPrompt(goal: string, snapshot: Snapshot, history: string[]): string {
  const elements = snapshot.nodes.map((n) => ({
    idx: n.idx,
    role: n.role,
    name: n.name,
    attrs: n.attrs,
  }))
  return [
    `GOAL: ${goal}`,
    `URL: ${snapshot.url}`,
    "",
    `ACTIONS SO FAR:${history.length ? "\n" + history.map((h, i) => `  ${i + 1}. ${h}`).join("\n") : " none"}`,
    "",
    "ELEMENTS:",
    JSON.stringify(elements),
    "",
    "Respond with the single next action.",
  ].join("\n")
}

export type LearnOptions = {
  goal: string
  url: string
  name: string
  llm: LlmClient
  backend: Backend
  maxTurns?: number
  maxSpendUsd?: number
}

export type LearnResult = { spec: FlowSpec; trace: Trace; telemetry: Telemetry }

async function act(page: Page, action: Action, selector: string): Promise<void> {
  const locator = page.locator(selector).first()
  switch (action.action) {
    case "click": await locator.click({ timeout: 5000 }); break
    case "fill": await locator.fill(action.value, { timeout: 5000 }); break
    case "select": await locator.selectOption(action.value, { timeout: 5000 }); break
    case "extract": await locator.waitFor({ state: "attached", timeout: 5000 }); break
    case "none": break
  }
}

export async function learn(opts: LearnOptions): Promise<LearnResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const maxSpend = opts.maxSpendUsd ?? DEFAULT_MAX_SPEND_USD
  const telemetry = emptyTelemetry()
  const steps: TraceStep[] = []
  const history: string[] = []

  const session = await opts.backend.open({ profile: null })
  const started = Date.now()

  try {
    await session.page.goto(opts.url, { timeout: 30_000 })

    for (let turn = 0; turn < maxTurns; turn++) {
      // Checked before the call, not after: the point of a guard is to
      // prevent the spend, not to notice it afterwards.
      if (telemetry.costUsd >= maxSpend) {
        throw new Error(
          `spend guard: $${telemetry.costUsd.toFixed(4)} reached the $${maxSpend.toFixed(2)} limit ` +
            `after ${turn} turns. Raise UNDERSTUDY_MAX_SPEND_USD to continue.`,
        )
      }

      const snapshotBefore = await observe(session.page)
      const urlBefore = session.page.url()

      const res = await opts.llm.complete<Action>({
        system: SYSTEM,
        prompt: buildPrompt(opts.goal, snapshotBefore, history),
        schema: ACTION_SCHEMA,
      })
      telemetry.llmCalls++
      telemetry.inputTokens += res.inputTokens
      telemetry.outputTokens += res.outputTokens
      telemetry.costUsd += res.costUsd

      const action = res.value
      if (action.done || action.action === "none") break

      const node = snapshotBefore.nodes.find((n) => n.idx === action.idx)
      if (!node) {
        history.push(`(skipped: idx ${action.idx} not on the page)`)
        continue
      }

      await act(session.page, action, node.selector)
      const snapshotAfter = await observe(session.page)

      steps.push({
        action: action.action,
        idx: action.idx,
        ...(action.value ? { value: action.value } : {}),
        ...(action.inputName ? { inputName: action.inputName } : {}),
        ...(action.as ? { as: action.as } : {}),
        urlBefore,
        urlAfter: session.page.url(),
        snapshotBefore,
        snapshotAfter,
      })
      history.push(`${action.action} "${node.name}"${action.value ? ` = ${action.value}` : ""}`)
    }

    telemetry.replayMs = Date.now() - started
    const trace: Trace = { goal: opts.goal, url: opts.url, steps }
    return { spec: compile(trace, opts.name), trace, telemetry }
  } finally {
    await session.close()
  }
}
