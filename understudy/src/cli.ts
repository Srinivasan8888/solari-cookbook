#!/usr/bin/env -S npx tsx
/**
 * understudy learn "<goal>" --url <url> --name <name>
 * understudy run <name> [--input k=v]... [--heal]
 * understudy diff <name>
 *
 * run prints telemetry to stderr and flow output as JSON to stdout, so it
 * pipes. Exit code is non-zero when a flow fails, so cron and CI can see it.
 */
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { formatTelemetry } from "./cost.js"
import { learn } from "./learn.js"
import { runFlow } from "./runtime.js"
import { llmHealer } from "./heal.js"
import { cassetteClient, type CassetteMode } from "./cassette.js"
import { openRouterClient, type LlmClient } from "./llm.js"
import { localBackend } from "./backends/local.js"
import { isHealable, loadFlow, saveFlow } from "./spec.js"
import type { Backend, Healer } from "./backends/types.js"

const ROOT = resolve(import.meta.dirname, "..")
const FLOWS = join(ROOT, "flows")

const DEFAULT_MODELS = [
  "dots-studio/dots-3-note-preview:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
]

function loadEnv(): void {
  const envPath = join(ROOT, ".env")
  if (!existsSync(envPath)) return
  const before = { ...process.env }
  try {
    process.loadEnvFile(envPath)
  } catch {
    // A malformed .env should not stop a run that needs no key.
    return
  }
  // The real environment wins over the dotfile. A caller who exported a value,
  // or deliberately cleared one, must not be silently overridden by a file on
  // disk -- otherwise "run this without credentials" is unenforceable.
  for (const [k, v] of Object.entries(before)) {
    if (v !== undefined) process.env[k] = v
  }
}

type Args = { _: string[]; flags: Record<string, string | boolean>; inputs: Record<string, string> }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, inputs: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    if (key === "input") {
      const [k, ...rest] = (argv[++i] ?? "").split("=")
      if (k) out.inputs[k] = rest.join("=")
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out.flags[key] = next
      i++
    } else {
      out.flags[key] = true
    }
  }
  return out
}

function llmClient(): LlmClient {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Put it in understudy/.env, or run without --heal.",
    )
  }
  const models = (process.env.UNDERSTUDY_MODELS ?? DEFAULT_MODELS.join(",")).split(",")
  const live = openRouterClient({ apiKey, models })
  const mode = (process.env.UNDERSTUDY_CASSETTE ?? "off") as CassetteMode
  if (mode === "off") return live
  return cassetteClient(live, {
    mode,
    path: join(ROOT, "fixtures", "cassettes", "cli.json"),
  })
}

function backendFor(name: unknown): Backend {
  if (name === "solari") throw new Error("the solari backend arrives in Plan 3")
  return localBackend()
}

function flowPath(name: string): string {
  return join(FLOWS, `${name}.json`)
}

async function cmdLearn(args: Args): Promise<number> {
  const goal = args._[0]
  const url = args.flags.url
  if (!goal || typeof url !== "string") {
    console.error('usage: understudy learn "<goal>" --url <url> [--name <name>]')
    return 2
  }
  const name =
    typeof args.flags.name === "string"
      ? args.flags.name
      : goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)

  const { spec, telemetry } = await learn({
    goal,
    url,
    name,
    llm: llmClient(),
    backend: backendFor(args.flags.backend),
    ...(args.flags["max-turns"] ? { maxTurns: Number(args.flags["max-turns"]) } : {}),
    ...(process.env.UNDERSTUDY_MAX_SPEND_USD
      ? { maxSpendUsd: Number(process.env.UNDERSTUDY_MAX_SPEND_USD) }
      : {}),
  })

  saveFlow(flowPath(name), spec)
  console.error(`learned ${spec.steps.length} steps  ${formatTelemetry(telemetry)}`)
  console.error(`wrote flows/${name}.json`)
  return 0
}

async function cmdRun(args: Args): Promise<number> {
  const name = args._[0]
  if (!name) {
    console.error("usage: understudy run <name> [--input k=v]... [--heal]")
    return 2
  }
  const flow = loadFlow(flowPath(name))

  // Healing is opt-in. Without --heal the healer is null, so the run
  // structurally cannot make an LLM call.
  const wantHeal = args.flags.heal === true && args.flags["no-heal"] !== true
  const healer: Healer | null = wantHeal ? llmHealer(llmClient()) : null

  const result = await runFlow(flow, args.inputs, {
    backend: backendFor(args.flags.backend ?? flow.backend),
    healer,
  })

  console.error(`${result.status}  ${formatTelemetry(result.telemetry)}`)
  for (const s of result.steps) {
    if (s.status === "healed") console.error(`  healed ${s.stepId} via ${s.tier} -> ${s.selectorUsed}`)
  }
  if (result.failure) console.error(`  failed at ${result.failure.stepId}: ${result.failure.reason}`)

  if (result.repaired) {
    saveFlow(flowPath(name), result.repaired)
    console.error(`  wrote flows/${name}.json v${result.repaired.version}`)
  }

  console.log(JSON.stringify(result.output, null, 2))
  return result.status === "ok" ? 0 : 1
}

function cmdDiff(args: Args): number {
  const name = args._[0]
  if (!name) {
    console.error("usage: understudy diff <name>")
    return 2
  }
  const flow = loadFlow(flowPath(name))
  console.log(`${flow.name} v${flow.version}`)
  let repairs = 0
  for (const step of flow.steps) {
    if (!isHealable(step)) continue
    for (const h of step.target.history) {
      repairs++
      console.log(`  ${step.id}  ${h.at}  ${h.tier}  $${h.costUsd.toFixed(4)}`)
      console.log(`    - ${h.from}`)
      console.log(`    + ${h.to}`)
      if (h.replayUrl) console.log(`    replay: ${h.replayUrl}`)
    }
  }
  if (repairs === 0) console.log("  no repairs recorded")
  return 0
}

async function main(): Promise<number> {
  loadEnv()
  const [, , command, ...rest] = process.argv
  const args = parseArgs(rest)
  switch (command) {
    case "learn": return cmdLearn(args)
    case "run": return cmdRun(args)
    case "diff": return cmdDiff(args)
    default:
      console.error("usage: understudy <learn|run|diff> ...")
      return 2
  }
}

process.exitCode = await main().catch((err: Error) => {
  console.error(`error: ${err.message}`)
  return 1
})
