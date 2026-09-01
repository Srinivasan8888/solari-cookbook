/**
 * The benchmark. Everything else in this project exists to make this table
 * possible, so it is a first-class command rather than a script.
 *
 *   B1  100 runs, asserted zero LLM calls and zero dollars
 *   B2  ten drift classes x N trials, recording which tier repaired each
 *   B3  100 runs after a repair, asserted back to zero
 *
 * Run: npm run bench
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { MUTATIONS } from "../demo-site/mutations.js"
import { observe } from "./observe.js"
import { compile, type Trace } from "./compile.js"
import { runFlow, type RunResult } from "./runtime.js"
import { localBackend } from "./backends/local.js"
import { llmHealer } from "./heal.js"
import { cassetteClient, type CassetteMode } from "./cassette.js"
import { openRouterClient } from "./llm.js"
import type { FlowSpec } from "./spec.js"
import type { Healer } from "./backends/types.js"

const ROOT = join(import.meta.dirname, "..")
const CASSETTE = join(ROOT, "fixtures", "cassettes", "bench.json")

const MODELS = (
  process.env.UNDERSTUDY_MODELS ??
  "dots-studio/dots-3-note-preview:free,z-ai/glm-5.2:free,nvidia/nemotron-3-super-120b-a12b:free"
).split(",")

function healer(): Healer {
  const live = openRouterClient({ apiKey: process.env.OPENROUTER_API_KEY ?? "", models: MODELS })
  const mode = (process.env.UNDERSTUDY_CASSETTE ?? "replay") as CassetteMode
  return llmHealer(cassetteClient(live, { mode, path: CASSETTE }))
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]!
}

/**
 * Build the baseline artifact by observing v1 and compiling a known trace.
 * Deliberately not hand-written: the benchmark must measure the anchors the
 * compiler actually produces, not ones tuned by hand to score well.
 */
async function baselineFlow(url: string): Promise<FlowSpec> {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(url)
  const before = await observe(page)

  const monthIdx = before.nodes.find((n) => n.selector === "#month")!.idx
  const loadIdx = before.nodes.find((n) => n.name === "Load invoices")!.idx

  await page.locator("#month").fill("2026-08")
  const afterFill = await observe(page)
  await page.locator("#load-btn").click()
  const afterClick = await observe(page)
  const statusIdx = afterClick.nodes.find((n) => n.selector === "#status")!.idx
  await browser.close()

  const trace: Trace = {
    goal: "load invoices for a month and read the result count",
    url,
    steps: [
      { action: "fill", idx: monthIdx, value: "2026-08", inputName: "month",
        urlBefore: url, urlAfter: url, snapshotBefore: before, snapshotAfter: afterFill },
      { action: "click", idx: loadIdx,
        urlBefore: url, urlAfter: url, snapshotBefore: afterFill, snapshotAfter: afterClick },
      { action: "extract", idx: statusIdx, as: "status",
        urlBefore: url, urlAfter: url, snapshotBefore: afterClick, snapshotAfter: afterClick },
    ],
  }
  return compile(trace, "invoice-export")
}

function rebase(flow: FlowSpec, url: string): FlowSpec {
  return {
    ...flow,
    url,
    steps: flow.steps.map((s) => (s.action === "goto" ? { ...s, url } : s)),
  }
}

async function repeat(flow: FlowSpec, url: string, n: number): Promise<{ ms: number[]; llmCalls: number; costUsd: number; failures: number }> {
  const ms: number[] = []
  let llmCalls = 0, costUsd = 0, failures = 0
  for (let i = 0; i < n; i++) {
    const r = await runFlow(rebase(flow, url), { month: "2026-08" }, {
      backend: localBackend(), healer: null,
    })
    ms.push(r.telemetry.replayMs)
    llmCalls += r.telemetry.llmCalls
    costUsd += r.telemetry.costUsd
    if (r.status !== "ok") failures++
  }
  return { ms, llmCalls, costUsd, failures }
}

export async function bench(opts: { runs?: number; trials?: number } = {}) {
  const runs = opts.runs ?? Number(process.env.BENCH_RUNS ?? 100)
  const trials = opts.trials ?? Number(process.env.BENCH_TRIALS ?? 5)

  const v1: DemoServer = await serveVariant("v1")
  const flow = await baselineFlow(v1.url)

  // ---- B1: the thesis run -------------------------------------------------
  const b1 = await repeat(flow, v1.url, runs)
  if (b1.llmCalls !== 0 || b1.costUsd !== 0) {
    throw new Error(`B1 violated: ${b1.llmCalls} LLM calls, $${b1.costUsd}`)
  }

  // ---- B2: the drift corpus ----------------------------------------------
  const heal = healer()
  const classes: {
    name: string; what: string; expected: string
    healed: number; trials: number; tiers: Record<string, number>
    llmCalls: number; inputTokens: number; outputTokens: number
    costUsd: number; healMs: number[]
  }[] = []

  for (const m of MUTATIONS) {
    const server = await serveVariant(`drift-${m.name}`)
    const row = {
      name: m.name, what: m.what, expected: m.expected,
      healed: 0, trials, tiers: {} as Record<string, number>,
      llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, healMs: [] as number[],
    }
    for (let t = 0; t < trials; t++) {
      let r: RunResult
      try {
        r = await runFlow(rebase(flow, server.url), { month: "2026-08" }, {
          backend: localBackend(), healer: heal,
        })
      } catch {
        continue
      }
      row.llmCalls += r.telemetry.llmCalls
      row.inputTokens += r.telemetry.inputTokens
      row.outputTokens += r.telemetry.outputTokens
      row.costUsd += r.telemetry.costUsd
      row.healMs.push(r.telemetry.healMs)
      if (r.status === "ok") {
        row.healed++
        const tier = r.steps.find((s) => s.status === "healed")?.tier ?? "none"
        row.tiers[tier] = (row.tiers[tier] ?? 0) + 1
      }
    }
    classes.push(row)
    await server.close()
    console.error(`  ${m.name.padEnd(14)} ${row.healed}/${trials}  ${JSON.stringify(row.tiers)}`)
  }

  // ---- B3: recovery -------------------------------------------------------
  const b3 = await repeat(flow, v1.url, runs)
  await v1.close()

  const totalHealed = classes.reduce((a, c) => a + c.healed, 0)
  const totalTrials = classes.reduce((a, c) => a + c.trials, 0)

  const report = {
    generatedAt: new Date().toISOString(),
    models: MODELS,
    b1: {
      runs, llmCalls: b1.llmCalls, costUsd: b1.costUsd, failures: b1.failures,
      p50Ms: percentile(b1.ms, 50), p95Ms: percentile(b1.ms, 95),
    },
    b2: {
      trialsPerClass: trials,
      healed: totalHealed,
      trials: totalTrials,
      costUsd: Number(classes.reduce((a, c) => a + c.costUsd, 0).toFixed(6)),
      classes: classes.map((c) => ({
        ...c,
        healP50Ms: percentile(c.healMs.filter((x) => x > 0), 50),
        healMs: undefined,
      })),
    },
    b3: {
      runs, llmCalls: b3.llmCalls, costUsd: b3.costUsd, failures: b3.failures,
      p50Ms: percentile(b3.ms, 50), p95Ms: percentile(b3.ms, 95),
    },
  }

  writeFileSync(join(ROOT, "benchmarks.json"), JSON.stringify(report, null, 2) + "\n")
  return report
}

if (process.argv[1] === import.meta.filename) {
  const r = await bench()
  console.error("")
  console.error(`B1  ${r.b1.runs} runs   ${r.b1.llmCalls} LLM calls  $${r.b1.costUsd.toFixed(4)}  p50 ${r.b1.p50Ms}ms`)
  console.error(`B2  ${r.b2.healed}/${r.b2.trials} healed across ${r.b2.classes.length} classes  $${r.b2.costUsd.toFixed(4)}`)
  console.error(`B3  ${r.b3.runs} runs   ${r.b3.llmCalls} LLM calls  $${r.b3.costUsd.toFixed(4)}  p50 ${r.b3.p50Ms}ms`)
  console.error("wrote benchmarks.json")
}
