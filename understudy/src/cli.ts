#!/usr/bin/env -S npx tsx
/**
 * understudy learn "<goal>" --url <url> --name <name>
 * understudy run <name> [--input k=v]... [--heal]
 * understudy diff <name>
 *
 * run prints telemetry to stderr and flow output as JSON to stdout, so it
 * pipes. Exit code is non-zero when a flow fails, so cron and CI can see it.
 */
import { createServer } from "node:http"
import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { formatTelemetry } from "./cost.js"
import { learn } from "./learn.js"
import { runFlow } from "./runtime.js"
import { llmHealer } from "./heal.js"
import { cassetteClient, type CassetteMode } from "./cassette.js"
import { openRouterClient, type LlmClient } from "./llm.js"
import { localBackend } from "./backends/local.js"
import { solariBackend } from "./backends/solari.js"
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
  if (name !== "solari") return localBackend()
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set. Get one at console.getsolari.com.")
  return solariBackend({
    apiKey,
    stealth: process.env.SOLARI_STEALTH === "1",
    ...(process.env.SOLARI_PROXY ? { proxy: process.env.SOLARI_PROXY } : {}),
    recording: process.env.SOLARI_RECORDING !== "0",
  })
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

/**
 * Every flow, healing off. The healer is null, so this command cannot make an
 * LLM call -- not "is configured not to", cannot. Exits non-zero on breakage,
 * which is what makes it usable as a cron or CI check with no spend risk.
 */
async function cmdDrift(args: Args): Promise<number> {
  const names = readdirSync(FLOWS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
  if (names.length === 0) {
    console.error("no flows in flows/")
    return 0
  }

  const report: Record<string, unknown>[] = []
  let broken = 0
  for (const name of names) {
    const flow = loadFlow(flowPath(name))
    const result = await runFlow(flow, args.inputs, {
      backend: backendFor(args.flags.backend ?? flow.backend),
      healer: null,
    })
    if (result.status !== "ok") broken++
    report.push({
      flow: name,
      status: result.status,
      replayMs: result.telemetry.replayMs,
      ...(result.failure ? { failedAt: result.failure.stepId, reason: result.failure.reason } : {}),
    })
    console.error(
      `${result.status === "ok" ? "ok    " : "DRIFT "} ${name}` +
        (result.failure ? `  ${result.failure.stepId}: ${result.failure.reason}` : ""),
    )
  }

  console.log(JSON.stringify(report, null, 2))
  console.error(`${names.length - broken}/${names.length} flows healthy, 0 LLM calls, $0.0000`)
  return broken === 0 ? 0 : 1
}

/**
 * A learned flow, exposed as an HTTP endpoint. This is the "web to API" claim
 * made literal: POST typed JSON in, get typed JSON out, with no model in the
 * request path unless the caller opts into healing.
 */
async function cmdServe(args: Args): Promise<number> {
  const port = Number(args.flags.port ?? 8080)
  const wantHeal = args.flags.heal === true

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(JSON.stringify(body, null, 2))
    }
    const match = /^\/flows\/([A-Za-z0-9_-]+)$/.exec((req.url ?? "").split("?")[0] ?? "")
    if (req.method !== "POST" || !match) {
      send(404, { error: "POST /flows/:name" })
      return
    }
    const name = match[1]!
    if (!existsSync(flowPath(name))) {
      send(404, { error: `no such flow: ${name}` })
      return
    }

    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      void (async () => {
        let inputs: Record<string, string> = {}
        try {
          const raw = Buffer.concat(chunks).toString("utf8")
          if (raw.trim()) inputs = JSON.parse(raw) as Record<string, string>
        } catch {
          send(400, { error: "body must be JSON" })
          return
        }
        try {
          const flow = loadFlow(flowPath(name))
          const result = await runFlow(flow, inputs, {
            backend: backendFor(args.flags.backend ?? flow.backend),
            healer: wantHeal ? llmHealer(llmClient()) : null,
          })
          if (result.repaired) saveFlow(flowPath(name), result.repaired)
          send(result.status === "ok" ? 200 : 502, {
            status: result.status,
            output: result.output,
            telemetry: result.telemetry,
            ...(result.failure ? { failure: result.failure } : {}),
          })
        } catch (err) {
          send(500, { error: (err as Error).message })
        }
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(port, resolve))
  console.error(`understudy serving on http://127.0.0.1:${port}`)
  console.error(`  curl -XPOST localhost:${port}/flows/invoice-export -d '{"month":"2026-08"}'`)
  console.error(wantHeal ? "  healing: ON (requests may cost money)" : "  healing: off (zero LLM calls)")
  await new Promise(() => {}) // serve until killed
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
    case "drift": return cmdDrift(args)
    case "serve": return cmdServe(args)
    default:
      console.error("usage: understudy <learn|run|drift|diff|serve> ...")
      return 2
  }
}

process.exitCode = await main().catch((err: Error) => {
  console.error(`error: ${err.message}`)
  return 1
})
