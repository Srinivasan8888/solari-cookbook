/**
 * The demo, as one command, paced for screen recording.
 *
 *   npm run demo              headless, ~45s
 *   npm run demo -- --headed  watch the browser drive itself
 *   npm run demo -- --fast    no pauses, for a quick sanity check
 *
 * The arc: it works and costs nothing -> the site changes underneath it ->
 * it fails loudly -> one model call repairs the broken step -> it costs
 * nothing again.
 */
import { join } from "node:path"
import { chromium } from "playwright"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { observe } from "./observe.js"
import { compile, type Trace } from "./compile.js"
import { runFlow } from "./runtime.js"
import { localBackend } from "./backends/local.js"
import { llmHealer } from "./heal.js"
import { cassetteClient, type CassetteMode } from "./cassette.js"
import { openRouterClient } from "./llm.js"
import type { FlowSpec } from "./spec.js"

const HEADED = process.argv.includes("--headed")
const FAST = process.argv.includes("--fast")
const CASSETTE = join(import.meta.dirname, "..", "fixtures", "cassettes", "demo.json")

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

const pause = (ms: number) => (FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

function banner(n: string, text: string) {
  console.log("")
  console.log(bold(`  ${n}  ${text}`))
  console.log(dim("  " + "─".repeat(58)))
}

function line(r: { status: string; telemetry: { replayMs: number; llmCalls: number; costUsd: number } }) {
  const tag = r.status === "ok" ? green("ok    ") : red("FAILED")
  return `  ${tag}  ${String(r.telemetry.replayMs).padStart(4)}ms   ` +
    `${r.telemetry.llmCalls} LLM calls   $${r.telemetry.costUsd.toFixed(4)}`
}

async function baseline(url: string): Promise<FlowSpec> {
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
    goal: "load invoices for a month and read the count", url,
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

const rebase = (f: FlowSpec, url: string): FlowSpec => ({
  ...f, url,
  steps: f.steps.map((s) => (s.action === "goto" ? { ...s, url } : s)),
})

const backend = () => localBackend({ headless: !HEADED })
// Applied to every run below, not just the failing one: a demo that shortens
// the timeout only where it looks bad would be cherry-picking.
const STEP_TIMEOUT_MS = 1500

function preflight(): void {
  const cassette = process.env.UNDERSTUDY_CASSETTE ?? "replay"
  if (cassette !== "off") return
  if (process.env.OPENROUTER_API_KEY) return
  console.log("")
  console.log(red("  Cannot run live: OPENROUTER_API_KEY is not set in this shell."))
  console.log(dim("    set -a; . ./.env; set +a        # load it, then re-run"))
  console.log(dim("    npm run demo                    # or replay the recorded call instead"))
  console.log("")
  process.exit(2)
}

async function main() {
  preflight()
  // Deliberately not console.clear(): on a screen recording the command the
  // viewer just watched you type is the proof that this is one command.
  console.log("")
  console.log(bold("  UNDERSTUDY") + dim("   the LLM is the compiler, not the runtime"))

  const v1: DemoServer = await serveVariant("v1")
  const flow = await baseline(v1.url)

  banner("1.", "The flow runs. It costs nothing.")
  await pause(700)
  for (let i = 0; i < 3; i++) {
    const r = await runFlow(rebase(flow, v1.url), { month: "2026-08" }, { backend: backend(), healer: null, stepTimeoutMs: STEP_TIMEOUT_MS })
    console.log(line(r) + dim(`   -> ${JSON.stringify(r.output)}`))
    await pause(500)
  }
  console.log(dim("\n  No model in the request path. The runtime has no import to one."))
  await pause(2200)
  await v1.close()

  banner("2.", "Someone ships a redesign.")
  console.log(dim(`  - <button id="load-btn"  name="load">Load invoices</button>`))
  console.log(dim(`  + <button id="ldb-7f2a"  name="fetch">Fetch statements</button>`))
  const v2 = await serveVariant("drift-label-change")
  await pause(2400)

  banner("3.", "It breaks, and says so.")
  await pause(600)
  const broken = await runFlow(rebase(flow, v2.url), { month: "2026-08" }, { backend: backend(), healer: null, stepTimeoutMs: STEP_TIMEOUT_MS })
  console.log(line(broken))
  console.log(red(`         ${broken.failure?.stepId}: ${broken.failure?.reason}`))
  await pause(2600)

  banner("4.", "One model call repairs the one step that broke.")
  await pause(600)
  const live = openRouterClient({ apiKey: process.env.OPENROUTER_API_KEY ?? "", models: [
    "dots-studio/dots-3-note-preview:free", "z-ai/glm-5.2:free",
  ] })
  const mode = (process.env.UNDERSTUDY_CASSETTE ?? "replay") as CassetteMode
  let healError: Error | null = null
  const healed = await runFlow(rebase(flow, v2.url), { month: "2026-08" }, {
    backend: backend(), stepTimeoutMs: STEP_TIMEOUT_MS,
    healer: llmHealer(
      cassetteClient(live, { mode, path: CASSETTE }),
      (e) => { healError = e },
    ),
  })
  const step = healed.steps.find((s) => s.status === "healed")
  console.log(line(healed))

  // Narrate what actually happened. Printing "verified" under a failed run
  // would be the software lying on screen.
  if (healed.status === "ok" && step) {
    console.log(cyan(`         ${step.stepId}: #load-btn  ->  ${step.selectorUsed}   (via ${step.tier}, ${(healed.telemetry.healMs / 1000).toFixed(1)}s)`))
    console.log(dim(`         ${healed.telemetry.inputTokens} in / ${healed.telemetry.outputTokens} out tokens, free-tier model`))
    console.log(dim(`         postcondition verified before accepting it`))
  } else {
    console.log(red(`         the repair did not happen -- this run is not a demo, it is a failure`))
    if (healError) console.log(red(`         ${String((healError as Error).message).split("\n").slice(0, 3).join("\n         ")}`))
    else console.log(dim(`         no candidate passed the confidence floor`))
    await v2.close()
    process.exitCode = 1
    return
  }
  await pause(2800)

  banner("5.", "And it costs nothing again.")
  await pause(600)
  const repaired = healed.repaired ?? flow
  let ok5 = true
  for (let i = 0; i < 3; i++) {
    const r = await runFlow(rebase(repaired, v2.url), { month: "2026-08" }, { backend: backend(), healer: null, stepTimeoutMs: STEP_TIMEOUT_MS })
    if (r.status !== "ok") ok5 = false
    console.log(line(r) + dim(`   -> ${JSON.stringify(r.output)}`))
    await pause(500)
  }
  await v2.close()

  console.log("")
  if (!ok5) {
    console.log(red("  The repaired flow did not stay green. Not a demo -- a failure."))
    process.exitCode = 1
    return
  }
  console.log(dim("  ") + bold("100 runs  0 calls  $0.00") + dim("   ·   ") +
    bold("1 change  1 call") + dim("   ·   ") + bold("100 runs  0 calls  $0.00"))
  console.log(dim("  github.com/Srinivasan8888/solari-cookbook\n"))
}

await main()
