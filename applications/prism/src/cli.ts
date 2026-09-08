/**
 * prism check [--backend local|solari] [--url URL] [--fix]
 *
 * With no --url, Prism starts its own demo site, which ships two deliberate
 * bugs: `free` sees the paid export button, and a visitor who refused consent
 * still gets the tracker. `--fix` serves the corrected app instead, so you can
 * see the same run go green.
 *
 * --backend local needs no credentials at all.
 */
import { serve } from "../demo-site/serve.js"
import { hostInSandbox } from "./host.js"
import { localBackend } from "./backends-local.js"
import { solariBackend } from "./backends-solari.js"
import { check } from "./check.js"
import { explain, table } from "./report.js"
import { CLASSES } from "./classes.js"
import { writeFileSync, mkdirSync } from "node:fs"
import type { Backend } from "./backend.js"

const argv = process.argv.slice(2)
const cmd = argv[0] ?? "check"
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? (argv[i + 1] ?? "") : d
}
const has = (n: string) => argv.includes(`--${n}`)

if (cmd !== "check") {
  console.error(`usage: prism check [--backend local|solari] [--url URL] [--fix]`)
  process.exit(2)
}

const backendName = flag("backend", "local")!
const bugs = has("fix")
  ? { leakExportToFree: false, trackerBeforeConsent: false }
  : { leakExportToFree: true, trackerBeforeConsent: true }

let site: { url: string; close: () => Promise<void> } | null = null
let url = flag("url")
let backend: Backend

if (backendName === "solari") {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    console.error("SOLARI_API_KEY is not set. `--backend local` needs no credentials.")
    process.exit(2)
  }
  if (url && (url.includes("127.0.0.1") || url.includes("localhost"))) {
    console.error(
      "A cloud browser cannot reach a URL on this machine.\n" +
      "Drop --url to have Prism host the demo site in a Solari sandbox, or point\n" +
      "--url at a publicly reachable address.",
    )
    process.exit(2)
  }
  if (!url) {
    // Browser and sandbox on the same key: the sandbox serves the demo site on
    // a public preview URL, which is the only way the cloud browser can see it.
    console.error("hosting the demo site in a Solari sandbox...")
    const hosted = await hostInSandbox(apiKey, { fix: has("fix") })
    site = hosted
    url = hosted.url
    console.error(`demo site: ${url} (guest node ${hosted.nodeVersion})`)
  }
  backend = await solariBackend({ apiKey })
} else {
  if (!url) {
    site = await serve(0, bugs)
    url = site.url
    console.error(`demo site: ${url}${has("fix") ? " (bugs fixed)" : " (with the two planted bugs)"}`)
  }
  backend = await localBackend()
}

console.error(`backend: ${backend.name}  classes: ${CLASSES.length}\n`)

try {
  const backpressure: number[] = []
  const results = await check(backend, url, CLASSES, (e) => {
    backpressure.push(e.concurrency)
    console.error(`  backpressure: concurrency now ${e.concurrency}`)
  })

  // `--proof FILE` writes the run as evidence. A table in a README is a claim;
  // a committed run with every class's actual testids is something a reader can
  // check against the code.
  const proof = flag("proof")
  if (proof) {
    mkdirSync(new URL(".", `file://${process.cwd()}/${proof}`).pathname, { recursive: true })
    writeFileSync(proof, JSON.stringify({
      backend: backend.name,
      classes: CLASSES.length,
      bugsPlanted: !has("fix"),
      // The signed pt_token is a live credential for the sandbox; record only
      // the origin so the evidence can be committed.
      target: url.startsWith("http") ? new URL(url).origin : url,
      backpressureEvents: backpressure,
      results: results.map((r) => ({
        name: r.name, ok: r.ok, saw: r.saw, findings: r.findings, ms: r.ms,
        ...(r.error ? { error: r.error } : {}),
      })),
    }, null, 2) + "\n")
    console.error(`proof written to ${proof}`)
  }
  console.log(table(results))
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.log(`\n${failed.length} of ${results.length} user classes saw the wrong page:\n`)
    console.log(explain(results))
  } else {
    console.log(`\nall ${results.length} user classes saw exactly what they should.`)
  }
  // Exit code: a real check must fail CI when a user class sees the wrong
  // page. But the DEMO is supposed to find its own planted bugs, and exiting
  // non-zero there reads as "the example is broken" rather than "it worked".
  // So the demo reports success for finding exactly what it planted.
  const isDemo = site !== null && !has("fix")
  if (isDemo) {
    const expected = ["free", "eu-consent-rejected"]
    const found = failed.map((r) => r.name).sort()
    const asPlanned = JSON.stringify(found) === JSON.stringify([...expected].sort())
    console.log(asPlanned
      ? `\nThis is the expected result: the demo site ships those two bugs on purpose,\nand Prism found both. Run with --fix to serve the corrected app and see it green.`
      : `\nUnexpected: the demo should fail exactly on ${expected.join(" and ")}.`)
    process.exitCode = asPlanned ? 0 : 1
  } else {
    process.exitCode = failed.length ? 1 : 0
  }
} finally {
  await backend.close()
  await site?.close()
}
