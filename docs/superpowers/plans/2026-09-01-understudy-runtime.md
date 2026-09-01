# Understudy — Plan 1: The Runtime and the Artifact

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic runtime that executes a hand-written `flow.json` against a real browser, verifies every step with a postcondition, and is structurally incapable of calling an LLM.

**Architecture:** Pure-function core (`spec`, `anchor`) with the browser injected at the edge through a `Backend` interface. The runtime accepts a `Healer | null`; in this plan it is always `null`, so the whole thing runs offline with zero API keys and zero cost. The compiler that *produces* `flow.json` is Plan 2 — here we hand-write the artifact, which is what lets the runtime be finished and tested before any LLM exists.

**Tech Stack:** TypeScript (Node 24), Playwright (local Chromium), Zod, Vitest, tsx.

**Cost to execute this plan: $0.** No Anthropic key, no Solari key, no network beyond `npm install`.

---

## Plan series

| Plan | Produces | Cost |
|---|---|---|
| **1 — Runtime and artifact** (this doc) | Deterministic flow runner, demo site, anchor scoring | $0 |
| 2 — Compiler and healer | `learn`, `compile`, `heal`, cassettes, CLI | ~$5 |
| 3 — Proof and ship | `bench`, `drift`, CI, `serve`, Solari backend, README, upstream PR | ~$3 |

---

## Design addition discovered while planning

The four-layer anchor (spec §4) makes a **free healing tier** possible that the spec did not
account for. The heal ladder becomes three rungs, not two:

1. `fallbacks` — free
2. **`rankCandidates(anchor, snapshot)` — free.** Score every element on the current page against
   the stored anchor. If the top candidate scores above `0.80` and beats the runner-up by `0.15`,
   accept it without any LLM call.
3. LLM — paid, and only now.

Rung 2 is expected to absorb the easy mutation classes outright (`id-rename`, `class-churn`,
`reorder`) at zero cost, leaving the LLM for the genuinely semantic ones (`i18n`, `icon-only`,
`reparent`). It also gives the drift corpus in Plan 3 a much more interesting result table:
*how many classes heal for free.*

This is built in Task 6 and 11 of this plan.

---

## File structure

```
understudy/
  package.json            deps, scripts
  tsconfig.json
  vitest.config.ts
  src/
    spec.ts               Zod schemas, types, load/save/version/history
    observe.ts            Page -> Snapshot (compact accessibility view)
    anchor.ts             Anchor scoring and candidate ranking (pure)
    cost.ts               Telemetry accumulator
    backends/
      types.ts            Backend / BackendSession / Healer interfaces
      local.ts            Playwright local Chromium
    runtime.ts            FlowSpec + inputs -> RunResult. MUST NOT import llm
  demo-site/
    v1/index.html         The invoice portal, working version
    serve.ts              node:http static server
  flows/
    invoice-export.json   Hand-written in this plan; compiler-produced in Plan 2
  test/
    spec.test.ts
    anchor.test.ts
    observe.test.ts
    runtime.test.ts
    isolation.test.ts
```

Responsibilities are split so that everything except `observe.ts`, `backends/local.ts` and
`runtime.ts` is a pure function over data — testable with no browser at all.

---

### Task 1: Scaffold

**Files:**
- Create: `understudy/package.json`
- Create: `understudy/tsconfig.json`
- Create: `understudy/vitest.config.ts`

- [ ] **Step 1: Create the package manifest**

`understudy/package.json`:

```json
{
  "name": "understudy",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "demo-site": "tsx demo-site/serve.ts"
  },
  "dependencies": {
    "playwright": "^1.56.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

`understudy/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "esModuleInterop": true
  },
  "include": ["src", "test", "demo-site"]
}
```

- [ ] **Step 3: Create the Vitest config**

`understudy/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Browser-backed tests are slower than the default 5s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
```

- [ ] **Step 4: Install and download Chromium**

Run:
```bash
cd understudy && npm install && npx playwright install chromium
```
Expected: `npm install` completes, then Chromium downloads (~150MB, one time).

- [ ] **Step 5: Commit**

```bash
git add understudy/package.json understudy/tsconfig.json understudy/vitest.config.ts
git commit -m "feat(understudy): scaffold TypeScript project"
```

---

### Task 2: Flow spec schema

The artifact everything else operates on. Note that `postcondition` is **required** on every
healable step variant — that is spec §4 enforced by the type system rather than by convention.

**Files:**
- Create: `understudy/src/spec.ts`
- Test: `understudy/test/spec.test.ts`

- [ ] **Step 1: Write the failing test**

`understudy/test/spec.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { FlowSpecSchema, StepSchema } from "../src/spec.js"

const anchor = {
  role: "button",
  name: "Export CSV",
  nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices"],
  landmarks: ["main"],
  siblingOrdinal: 2,
  siblingRole: "button",
  textFingerprint: ["export", "csv"],
}

const target = { primary: "#export-btn", fallbacks: [], anchor }

describe("StepSchema", () => {
  it("accepts a click step that has a postcondition", () => {
    const step = {
      id: "s1",
      action: "click",
      target,
      postcondition: { type: "urlContains", value: "/download" },
    }
    expect(StepSchema.parse(step)).toMatchObject({ id: "s1", action: "click" })
  })

  it("REJECTS a click step with no postcondition", () => {
    const step = { id: "s1", action: "click", target }
    expect(() => StepSchema.parse(step)).toThrow()
  })

  it("accepts a goto step, which is not healable and needs no postcondition", () => {
    const step = { id: "s0", action: "goto", url: "https://example.com" }
    expect(StepSchema.parse(step)).toMatchObject({ action: "goto" })
  })
})

describe("FlowSpecSchema", () => {
  it("defaults version to 1 and backend to local", () => {
    const flow = FlowSpecSchema.parse({
      name: "demo",
      url: "https://example.com",
      steps: [{ id: "s0", action: "goto", url: "https://example.com" }],
    })
    expect(flow.version).toBe(1)
    expect(flow.backend).toBe("local")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/spec.test.ts`
Expected: FAIL — `Cannot find module '../src/spec.js'`

- [ ] **Step 3: Write the schema**

`understudy/src/spec.ts`:

```ts
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
// against is a guess that reports itself as a success (spec section 4).
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
  inputs: z.record(z.object({
    type: z.literal("string"),
    required: z.boolean().default(true),
  })).default({}),
  steps: z.array(StepSchema),
})
export type FlowSpec = z.infer<typeof FlowSpecSchema>

/** Steps whose target can be repaired. `goto` and `assert` have no target. */
export function isHealable(
  step: Step,
): step is Extract<Step, { target: Target }> {
  return step.action !== "goto" && step.action !== "assert"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd understudy && npx vitest run test/spec.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add understudy/src/spec.ts understudy/test/spec.test.ts
git commit -m "feat(understudy): flow spec schema with mandatory postconditions"
```

---

### Task 3: Load, save, and version the artifact

**Files:**
- Modify: `understudy/src/spec.ts` (append)
- Modify: `understudy/test/spec.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `understudy/test/spec.test.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadFlow, saveFlow, recordRepair } from "../src/spec.js"

describe("loadFlow / saveFlow", () => {
  it("round-trips a flow through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-"))
    const path = join(dir, "demo.json")
    const flow = FlowSpecSchema.parse({
      name: "demo",
      url: "https://example.com",
      steps: [{ id: "s0", action: "goto", url: "https://example.com" }],
    })
    saveFlow(path, flow)
    expect(loadFlow(path)).toEqual(flow)
  })
})

describe("recordRepair", () => {
  it("bumps version, swaps the selector, and appends history", () => {
    const flow = FlowSpecSchema.parse({
      name: "demo",
      url: "https://example.com",
      steps: [
        { id: "s0", action: "goto", url: "https://example.com" },
        { id: "s1", action: "click", target, postcondition: { type: "domChanged" } },
      ],
    })

    const next = recordRepair(flow, "s1", {
      at: "2026-09-01T00:00:00.000Z",
      from: "#export-btn",
      to: "#btn-export",
      tier: "anchor",
      costUsd: 0,
      replayUrl: null,
    })

    expect(next.version).toBe(2)
    const step = next.steps[1]
    if (step?.action !== "click") throw new Error("expected click step")
    expect(step.target.primary).toBe("#btn-export")
    expect(step.target.fallbacks).toContain("#export-btn")
    expect(step.target.history).toHaveLength(1)

    // The original must be untouched.
    const original = flow.steps[1]
    if (original?.action !== "click") throw new Error("expected click step")
    expect(original.target.primary).toBe("#export-btn")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/spec.test.ts`
Expected: FAIL — `loadFlow is not exported`

- [ ] **Step 3: Implement**

Append to `understudy/src/spec.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd understudy && npx vitest run test/spec.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add understudy/src/spec.ts understudy/test/spec.test.ts
git commit -m "feat(understudy): load, save, and immutable repair recording"
```

---

### Task 4: The demo site

The v1 invoice portal. Mutation variants come in Plan 3; this is the working version everything
is built against.

**Files:**
- Create: `understudy/demo-site/v1/index.html`
- Create: `understudy/demo-site/serve.ts`

- [ ] **Step 1: Write the page**

`understudy/demo-site/v1/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Acme Invoices</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 2rem; color: #16171a; }
  nav { display: flex; gap: 1rem; border-bottom: 1px solid #d8dade; padding-bottom: .75rem; }
  nav a { text-decoration: none; color: #55585f; padding: .25rem .5rem; }
  nav a[aria-current="page"] { color: #16171a; font-weight: 600; }
  main { max-width: 640px; margin-top: 1.5rem; }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 500; }
  input, button { font: inherit; padding: .5rem .75rem; }
  button { background: #16171a; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  table { border-collapse: collapse; margin-top: 1.25rem; width: 100%; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid #e8eaed; }
</style>

<nav>
  <a href="#dashboard" id="dashboard-tab">Dashboard</a>
  <a href="#invoices" id="invoices-tab" aria-current="page">Invoices</a>
  <a href="#settings" id="settings-tab">Settings</a>
</nav>

<main>
  <section id="invoices" aria-label="Invoices">
    <h1>Invoices</h1>
    <label for="month">Billing month</label>
    <input id="month" name="month" type="text" placeholder="YYYY-MM" value="">
    <p>
      <button id="load-btn" name="load" type="button">Load invoices</button>
      <button id="export-btn" name="export" type="submit">Export CSV</button>
    </p>
    <table id="results" hidden>
      <thead><tr><th>Invoice</th><th>Amount</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p id="status"></p>
  </section>
</main>

<script>
  const rowsFor = (month) => [
    { id: `INV-${month}-001`, amount: "$1,240.00" },
    { id: `INV-${month}-002`, amount: "$880.50" },
    { id: `INV-${month}-003`, amount: "$3,015.25" },
  ]

  document.getElementById("load-btn").addEventListener("click", () => {
    const month = document.getElementById("month").value.trim()
    if (!month) { document.getElementById("status").textContent = "Enter a month first."; return }
    const body = document.getElementById("rows")
    body.replaceChildren(...rowsFor(month).map((r) => {
      const tr = document.createElement("tr")
      const a = document.createElement("td"); a.textContent = r.id
      const b = document.createElement("td"); b.textContent = r.amount
      tr.append(a, b); return tr
    }))
    document.getElementById("results").hidden = false
    document.getElementById("status").textContent = `${rowsFor(month).length} results`
  })

  document.getElementById("export-btn").addEventListener("click", () => {
    if (document.getElementById("results").hidden) {
      document.getElementById("status").textContent = "Load invoices before exporting."
      return
    }
    location.hash = "#/download/ready"
  })
</script>
```

- [ ] **Step 2: Write the static server**

`understudy/demo-site/serve.ts`:

```ts
/**
 * Serves a demo-site variant on a port. Used by tests (which pick port 0 and
 * read back the assigned port) and by `npm run demo-site` for eyeballing it.
 */
import { createServer, type Server } from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))

export type DemoServer = { url: string; close: () => Promise<void> }

export async function serveVariant(variant: string, port = 0): Promise<DemoServer> {
  const html = readFileSync(join(here, variant, "index.html"), "utf8")
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  const addr = server.address()
  if (addr === null || typeof addr === "string") throw new Error("no port assigned")
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const variant = process.argv[2] ?? "v1"
  const { url } = await serveVariant(variant, 8787)
  console.log(`${variant} serving at ${url}`)
}
```

- [ ] **Step 3: Verify it serves**

Run: `cd understudy && npx tsx demo-site/serve.ts v1`
Expected: prints `v1 serving at http://127.0.0.1:8787/`. Open it, type `2026-08`, click
**Load invoices** — three rows and "3 results" appear. Click **Export CSV** — the URL gains
`#/download/ready`. Ctrl-C to stop.

- [ ] **Step 4: Commit**

```bash
git add understudy/demo-site
git commit -m "feat(understudy): demo invoice portal and static server"
```

---

### Task 5: Observe — page to compact snapshot

The largest cost lever in the project (spec §7). Never send raw HTML; send a ranked list of
interactive elements with the same shape as an `Anchor`, so scoring in Task 6 is a field-by-field
comparison.

**Files:**
- Create: `understudy/src/observe.ts`
- Test: `understudy/test/observe.test.ts`

- [ ] **Step 1: Write the failing test**

`understudy/test/observe.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser, type Page } from "playwright"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { observe } from "../src/observe.js"

let server: DemoServer
let browser: Browser
let page: Page

beforeAll(async () => {
  server = await serveVariant("v1")
  browser = await chromium.launch()
  page = await browser.newPage()
  await page.goto(server.url)
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

describe("observe", () => {
  it("finds the export button with role, name and attributes", async () => {
    const snapshot = await observe(page)
    const node = snapshot.nodes.find((n) => n.name === "Export CSV")
    expect(node).toBeDefined()
    expect(node!.role).toBe("button")
    expect(node!.nameNormalized).toBe("export csv")
    expect(node!.attrs.name).toBe("export")
    expect(node!.selector).toBe("#export-btn")
  })

  it("labels the month input from its <label for>", async () => {
    const snapshot = await observe(page)
    const node = snapshot.nodes.find((n) => n.selector === "#month")
    expect(node!.role).toBe("textbox")
    expect(node!.name).toBe("Billing month")
  })

  it("records landmarks and sibling ordinals", async () => {
    const snapshot = await observe(page)
    const node = snapshot.nodes.find((n) => n.name === "Export CSV")!
    expect(node.landmarks.join(" ")).toContain("section")
    expect(node.siblingRole).toBe("button")
    expect(node.siblingOrdinal).toBe(1) // second button in its parent
  })

  it("stays small enough to be cheap", async () => {
    const snapshot = await observe(page)
    expect(snapshot.nodes.length).toBeLessThanOrEqual(120)
    expect(JSON.stringify(snapshot).length).toBeLessThan(6000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/observe.test.ts`
Expected: FAIL — `Cannot find module '../src/observe.js'`

- [ ] **Step 3: Implement**

`understudy/src/observe.ts`:

```ts
import type { Page } from "playwright"

export type SnapshotNode = {
  idx: number
  role: string
  name: string
  nameNormalized: string
  attrs: { testId: string | null; name: string | null; type: string | null }
  nearText: string[]
  landmarks: string[]
  siblingOrdinal: number
  siblingRole: string
  textFingerprint: string[]
  selector: string
}

export type Snapshot = { url: string; nodes: SnapshotNode[] }

export const MAX_NODES = 120

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

export function fingerprint(text: string): string[] {
  return [...new Set(normalize(text).split(/[^a-z0-9]+/).filter((t) => t.length > 1))]
}

export async function observe(page: Page): Promise<Snapshot> {
  const nodes = await page.evaluate((maxNodes) => {
    const INTERACTIVE = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem]"

    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute("role")
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === "a") return el.hasAttribute("href") ? "link" : "generic"
      if (tag === "button" || tag === "summary") return "button"
      if (tag === "select") return "combobox"
      if (tag === "textarea") return "textbox"
      if (tag === "input") {
        const t = (el.getAttribute("type") ?? "text").toLowerCase()
        if (t === "checkbox" || t === "radio") return t
        if (t === "submit" || t === "button" || t === "reset") return "button"
        return "textbox"
      }
      return "generic"
    }

    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label")
      if (aria?.trim()) return aria.trim()
      const by = el.getAttribute("aria-labelledby")
      if (by) {
        const t = by.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ").trim()
        if (t) return t
      }
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (lab?.textContent?.trim()) return lab.textContent.trim()
      }
      const wrapping = el.closest("label")
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim()
      const ph = el.getAttribute("placeholder")
      if (ph?.trim()) return ph.trim()
      const value = (el as HTMLInputElement).value
      if (el.tagName === "INPUT" && value) return value
      return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
    }

    const selectorFor = (el: Element): string => {
      const testId = el.getAttribute("data-testid")
      if (testId) return `[data-testid="${testId}"]`
      if (el.id) return `#${CSS.escape(el.id)}`
      const parts: string[] = []
      let cur: Element | null = el
      while (cur && cur !== document.body && parts.length < 4) {
        const parent: Element | null = cur.parentElement
        if (!parent) break
        const tag = cur.tagName.toLowerCase()
        const sameTag = [...parent.children].filter((c) => c.tagName === cur!.tagName)
        parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : tag)
        cur = parent
      }
      return parts.join(" > ")
    }

    const landmarksFor = (el: Element): string[] => {
      const out: string[] = []
      let cur: Element | null = el.parentElement
      while (cur && cur !== document.documentElement) {
        const tag = cur.tagName.toLowerCase()
        if (["main", "nav", "header", "footer", "aside", "form", "section"].includes(tag)) {
          const label = cur.getAttribute("aria-label")
          out.unshift(label ? `${tag}[${label}]` : tag)
        }
        cur = cur.parentElement
      }
      return out.slice(-3)
    }

    const nearTextFor = (el: Element): string[] => {
      const out: string[] = []
      let cur: Element | null = el.parentElement
      let hops = 0
      while (cur && hops < 3) {
        for (const child of cur.children) {
          if (child === el || child.contains(el)) continue
          const t = (child.textContent ?? "").replace(/\s+/g, " ").trim()
          if (t && t.length <= 40) out.push(t)
        }
        cur = cur.parentElement
        hops++
      }
      return [...new Set(out)].slice(0, 5)
    }

    const els = [...document.querySelectorAll(INTERACTIVE)].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })

    return els.slice(0, maxNodes).map((el, idx) => {
      const role = roleOf(el)
      const name = nameOf(el)
      const parent = el.parentElement
      const sameRole = parent
        ? [...parent.children].filter((c) => roleOf(c) === role)
        : [el]
      return {
        idx,
        role,
        name,
        attrs: {
          testId: el.getAttribute("data-testid"),
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
        },
        nearText: nearTextFor(el),
        landmarks: landmarksFor(el),
        siblingOrdinal: sameRole.indexOf(el),
        siblingRole: role,
        rawName: name,
        selector: selectorFor(el),
      }
    })
  }, MAX_NODES)

  return {
    url: page.url(),
    nodes: nodes.map((n) => ({
      ...n,
      nameNormalized: normalize(n.name),
      textFingerprint: fingerprint(`${n.name} ${n.nearText.join(" ")}`),
    })),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd understudy && npx vitest run test/observe.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add understudy/src/observe.ts understudy/test/observe.test.ts
git commit -m "feat(understudy): compact accessibility snapshot"
```

---

### Task 6: Anchor scoring — the free healing tier

Pure functions, no browser, no network. This is what absorbs the cheap mutation classes at
zero cost.

**Files:**
- Create: `understudy/src/anchor.ts`
- Test: `understudy/test/anchor.test.ts`

- [ ] **Step 1: Write the failing test**

`understudy/test/anchor.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { rankCandidates, scoreCandidate, ACCEPT_SCORE, ACCEPT_MARGIN } from "../src/anchor.js"
import type { Anchor } from "../src/spec.js"
import type { Snapshot, SnapshotNode } from "../src/observe.js"

const anchor: Anchor = {
  role: "button",
  name: "Export CSV",
  nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices", "3 results"],
  landmarks: ["main", "section[Invoices]"],
  siblingOrdinal: 1,
  siblingRole: "button",
  textFingerprint: ["export", "csv", "invoices"],
}

const node = (over: Partial<SnapshotNode>): SnapshotNode => ({
  idx: 0,
  role: "button",
  name: "Export CSV",
  nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices", "3 results"],
  landmarks: ["main", "section[Invoices]"],
  siblingOrdinal: 1,
  siblingRole: "button",
  textFingerprint: ["export", "csv", "invoices"],
  selector: "#export-btn",
  ...over,
})

describe("scoreCandidate", () => {
  it("scores an identical element at 1", () => {
    expect(scoreCandidate(anchor, node({}))).toBeCloseTo(1, 5)
  })

  it("still accepts after an id rename, since no scored field uses the id", () => {
    expect(scoreCandidate(anchor, node({ selector: "#btn-export" }))).toBeCloseTo(1, 5)
  })

  it("stays above the accept threshold when only the label changes", () => {
    const renamed = node({
      name: "Download report",
      nameNormalized: "download report",
      textFingerprint: ["download", "report", "invoices"],
      selector: "#export-btn",
    })
    expect(scoreCandidate(anchor, renamed)).toBeGreaterThan(ACCEPT_SCORE)
  })

  it("scores an unrelated element low", () => {
    const other = node({
      role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null },
      nearText: [], landmarks: ["nav"], siblingOrdinal: 2, siblingRole: "link",
      textFingerprint: ["settings"], selector: "#settings-tab",
    })
    expect(scoreCandidate(anchor, other)).toBeLessThan(0.4)
  })
})

describe("rankCandidates", () => {
  const snapshot = (nodes: SnapshotNode[]): Snapshot => ({ url: "http://x/", nodes })

  it("returns the best match first with an accept decision", () => {
    const best = node({ selector: "#btn-export" })
    const decoy = node({
      role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null },
      nearText: [], landmarks: ["nav"], siblingOrdinal: 0, siblingRole: "link",
      textFingerprint: ["settings"], selector: "#settings-tab",
    })
    const ranked = rankCandidates(anchor, snapshot([decoy, best]))
    expect(ranked.accepted?.selector).toBe("#btn-export")
  })

  it("refuses to accept when two candidates are equally good", () => {
    const a = node({ selector: "#export-a" })
    const b = node({ selector: "#export-b" })
    const ranked = rankCandidates(anchor, snapshot([a, b]))
    expect(ranked.accepted).toBeNull()
    expect(ranked.ranked[0]!.score - ranked.ranked[1]!.score).toBeLessThan(ACCEPT_MARGIN)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/anchor.test.ts`
Expected: FAIL — `Cannot find module '../src/anchor.js'`

- [ ] **Step 3: Implement**

`understudy/src/anchor.ts`:

```ts
import type { Anchor } from "./spec.js"
import type { Snapshot, SnapshotNode } from "./observe.js"

/** Accept a free repair only above this score... */
export const ACCEPT_SCORE = 0.8
/** ...and only if it beats the runner-up by this much. */
export const ACCEPT_MARGIN = 0.15

const WEIGHTS = {
  role: 0.2,
  name: 0.25,
  attrs: 0.2,
  nearText: 0.15,
  landmarks: 0.05,
  sibling: 0.1,
  fingerprint: 0.05,
} as const

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const A = new Set(a), B = new Set(b)
  const inter = [...A].filter((x) => B.has(x)).length
  const union = new Set([...A, ...B]).size
  return union === 0 ? 0 : inter / union
}

/**
 * Four independent layers, so no single page change can zero every term.
 * A rename kills `name` but not `attrs` or `sibling`; a redesign kills
 * `sibling` but not `role` or `nearText`.
 */
export function scoreCandidate(anchor: Anchor, node: SnapshotNode): number {
  const role = anchor.role === node.role ? 1 : 0
  const name = anchor.nameNormalized === node.nameNormalized ? 1 : 0

  const attrKeys = ["testId", "name", "type"] as const
  const present = attrKeys.filter((k) => anchor.attrs[k] !== null)
  const attrs = present.length === 0
    ? 0.5
    : present.filter((k) => anchor.attrs[k] === node.attrs[k]).length / present.length

  const nearText = jaccard(anchor.nearText, node.nearText)
  const landmarks = jaccard(anchor.landmarks, node.landmarks)
  const sibling =
    (anchor.siblingRole === node.siblingRole ? 0.5 : 0) +
    (anchor.siblingOrdinal === node.siblingOrdinal ? 0.5 : 0)
  const fp = jaccard(anchor.textFingerprint, node.textFingerprint)

  return (
    role * WEIGHTS.role +
    name * WEIGHTS.name +
    attrs * WEIGHTS.attrs +
    nearText * WEIGHTS.nearText +
    landmarks * WEIGHTS.landmarks +
    sibling * WEIGHTS.sibling +
    fp * WEIGHTS.fingerprint
  )
}

export type Ranking = {
  ranked: { node: SnapshotNode; score: number }[]
  /** Non-null only when confident AND unambiguous. */
  accepted: SnapshotNode | null
}

export function rankCandidates(anchor: Anchor, snapshot: Snapshot): Ranking {
  const ranked = snapshot.nodes
    .map((node) => ({ node, score: scoreCandidate(anchor, node) }))
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]
  const second = ranked[1]
  const confident = best !== undefined && best.score >= ACCEPT_SCORE
  const unambiguous = second === undefined || best!.score - second.score >= ACCEPT_MARGIN

  return { ranked, accepted: confident && unambiguous ? best!.node : null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd understudy && npx vitest run test/anchor.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add understudy/src/anchor.ts understudy/test/anchor.test.ts
git commit -m "feat(understudy): four-layer anchor scoring with free repair tier"
```

---

### Task 7: Backend interface and local backend

**Files:**
- Create: `understudy/src/backends/types.ts`
- Create: `understudy/src/backends/local.ts`

- [ ] **Step 1: Define the interfaces**

`understudy/src/backends/types.ts`:

```ts
import type { Page } from "playwright"
import type { Anchor } from "../spec.js"
import type { Snapshot } from "../observe.js"

export interface BackendSession {
  page: Page
  /** Solari returns a shareable replay link; local has none. */
  replayUrl(): Promise<string | null>
  close(): Promise<void>
}

export interface Backend {
  name: "local" | "solari"
  open(opts: { profile: string | null }): Promise<BackendSession>
}

/**
 * The paid repair tier. Defined here so runtime.ts can depend on the interface
 * without importing anything that can reach the network. Implemented in Plan 2.
 */
export interface Healer {
  heal(input: {
    anchor: Anchor
    snapshot: Snapshot
    failedSelector: string
  }): Promise<{ selector: string; costUsd: number } | null>
  // Latency is measured by the runtime, not self-reported.
}
```

- [ ] **Step 2: Implement the local backend**

`understudy/src/backends/local.ts`:

```ts
import { chromium, type Browser } from "playwright"
import type { Backend, BackendSession } from "./types.js"

export function localBackend(opts: { headless?: boolean } = {}): Backend {
  return {
    name: "local",
    async open(): Promise<BackendSession> {
      const browser: Browser = await chromium.launch({ headless: opts.headless ?? true })
      const context = await browser.newContext()
      const page = await context.newPage()
      return {
        page,
        async replayUrl() { return null },
        async close() { await browser.close() },
      }
    },
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd understudy && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add understudy/src/backends
git commit -m "feat(understudy): backend interface and local Playwright backend"
```

---

### Task 8: Cost telemetry

**Files:**
- Create: `understudy/src/cost.ts`

- [ ] **Step 1: Implement**

`understudy/src/cost.ts`:

```ts
export type Telemetry = {
  llmCalls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Replay and heal are reported separately; averaging them hides the point. */
  replayMs: number
  healMs: number
}

export function emptyTelemetry(): Telemetry {
  return { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, replayMs: 0, healMs: 0 }
}

export function formatTelemetry(t: Telemetry): string {
  return [
    `replay ${t.replayMs}ms`,
    `heal ${t.healMs}ms`,
    `llmCalls ${t.llmCalls}`,
    `tokens ${t.inputTokens}in/${t.outputTokens}out`,
    `cost $${t.costUsd.toFixed(4)}`,
  ].join("  ")
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `cd understudy && npx tsc --noEmit`
Expected: no errors.

```bash
git add understudy/src/cost.ts
git commit -m "feat(understudy): run telemetry"
```

---

### Task 9: The runtime — happy path

**Files:**
- Create: `understudy/src/runtime.ts`
- Test: `understudy/test/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

`understudy/test/runtime.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"
import { localBackend } from "../src/backends/local.js"
import { runFlow } from "../src/runtime.js"
import { FlowSpecSchema, type FlowSpec } from "../src/spec.js"

let server: DemoServer

const anchorFor = (over: Record<string, unknown> = {}) => ({
  role: "button", name: "x", nameNormalized: "x",
  attrs: { testId: null, name: null, type: null },
  nearText: [], landmarks: [], siblingOrdinal: 0, siblingRole: "button",
  textFingerprint: [], ...over,
})

function flow(url: string): FlowSpec {
  return FlowSpecSchema.parse({
    name: "invoice-export",
    url,
    inputs: { month: { type: "string", required: true } },
    steps: [
      { id: "s0", action: "goto", url },
      {
        id: "s1", action: "fill", value: "{{month}}",
        target: { primary: "#month", fallbacks: [], anchor: anchorFor({ role: "textbox", siblingRole: "textbox" }) },
        postcondition: { type: "domChanged" },
      },
      {
        id: "s2", action: "click",
        target: { primary: "#load-btn", fallbacks: [], anchor: anchorFor({ name: "Load invoices", nameNormalized: "load invoices" }) },
        postcondition: { type: "selectorVisible", value: "#results" },
      },
      {
        id: "s3", action: "extract", as: "status",
        target: { primary: "#status", fallbacks: [], anchor: anchorFor({ role: "generic", siblingRole: "generic" }) },
        postcondition: { type: "textPresent", value: "results" },
      },
    ],
  })
}

beforeAll(async () => { server = await serveVariant("v1") })
afterAll(async () => { await server.close() })

describe("runFlow", () => {
  it("runs green with zero LLM calls and zero cost", async () => {
    const result = await runFlow(flow(server.url), { month: "2026-08" }, {
      backend: localBackend(),
      healer: null,
    })
    expect(result.status).toBe("ok")
    expect(result.telemetry.llmCalls).toBe(0)
    expect(result.telemetry.costUsd).toBe(0)
    expect(result.output.status).toContain("3 results")
    expect(result.steps.every((s) => s.status === "ok")).toBe(true)
  })

  it("substitutes inputs into step values", async () => {
    const result = await runFlow(flow(server.url), { month: "2026-01" }, {
      backend: localBackend(), healer: null,
    })
    expect(result.output.status).toContain("3 results")
  })

  it("fails loudly, and names the step, when a selector is missing and healing is off", async () => {
    const broken = flow(server.url)
    const step = broken.steps[2]
    if (step?.action !== "click") throw new Error("expected click")
    step.target.primary = "#nope-does-not-exist"

    const result = await runFlow(broken, { month: "2026-08" }, {
      backend: localBackend(), healer: null,
    })
    expect(result.status).toBe("failed")
    expect(result.failure?.stepId).toBe("s2")
    expect(result.telemetry.llmCalls).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/runtime.test.ts`
Expected: FAIL — `Cannot find module '../src/runtime.js'`

- [ ] **Step 3: Implement**

`understudy/src/runtime.ts`:

```ts
// NOTE: this module must never import an LLM client, directly or transitively.
// Enforced by test/isolation.test.ts. Repair arrives through the injected
// Healer interface, which is null unless the caller opts in.
import type { Page } from "playwright"
import { isHealable, recordRepair, type FlowSpec, type Postcondition, type Step, type Target } from "./spec.js"
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
        await page.getByText(post.value, { exact: false }).first()
          .waitFor({ state: "visible", timeout: timeoutMs })
        return true
      case "domChanged": {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if ((await page.content()) !== before) return true
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
    if (await page.locator(candidate).first().count() > 0) {
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
  telemetry.healMs += Date.now() - started
  if (!healed) return null

  telemetry.llmCalls += 1
  telemetry.costUsd += healed.costUsd
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

  try {
    for (const step of current.steps) {
      const startedStep = Date.now()

      if (step.action === "goto") {
        await session.page.goto(step.url, { timeout: timeoutMs * 2 })
        steps.push({ stepId: step.id, status: "ok", ms: Date.now() - startedStep, selectorUsed: null })
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

      const before = await session.page.content()
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
        const fix = await repair(session.page, step.target, opts.healer, telemetry)
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
        telemetry.replayMs = Date.now() - startedAll - telemetry.healMs
        return {
          flow: current.name, version: current.version, status: "failed",
          telemetry, steps, output,
          failure: { stepId: step.id, reason: `no working selector for ${step.target.primary}` },
        }
      }

      if (step.action === "extract" && extracted !== null) output[step.as] = extracted
    }

    telemetry.replayMs = Date.now() - startedAll - telemetry.healMs
    return {
      flow: current.name, version: current.version, status: "ok",
      telemetry, steps, output,
      ...(current.version !== flow.version ? { repaired: current } : {}),
    }
  } finally {
    await session.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd understudy && npx vitest run test/runtime.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add understudy/src/runtime.ts understudy/test/runtime.test.ts
git commit -m "feat(understudy): deterministic runtime with verified three-tier repair"
```

---

### Task 10: Free healing proves itself

The anchor tier repairs an `id-rename` with no LLM and no key. This is the test that makes the
Plan 3 benchmark believable.

**Files:**
- Create: `understudy/demo-site/v2-id-rename/index.html`
- Modify: `understudy/test/runtime.test.ts` (append)

- [ ] **Step 1: Create the mutated variant**

Copy `understudy/demo-site/v1/index.html` to `understudy/demo-site/v2-id-rename/index.html`,
then change exactly three things — every `id="load-btn"` becomes `id="btn-load"`,
`id="export-btn"` becomes `id="btn-export"`, and the two `getElementById` calls in the script
are updated to match. Change nothing else: same labels, same structure, same `name` attributes.

Run this to create it, then make those edits:
```bash
mkdir -p understudy/demo-site/v2-id-rename
sed -e 's/id="load-btn"/id="btn-load"/' \
    -e 's/id="export-btn"/id="btn-export"/' \
    -e 's/getElementById("load-btn")/getElementById("btn-load")/' \
    -e 's/getElementById("export-btn")/getElementById("btn-export")/' \
    understudy/demo-site/v1/index.html > understudy/demo-site/v2-id-rename/index.html
```

- [ ] **Step 2: Write the failing test**

Append to `understudy/test/runtime.test.ts`:

```ts
describe("free repair tier", () => {
  it("heals an id rename with zero LLM calls and zero dollars", async () => {
    const mutated = await serveVariant("v2-id-rename")
    try {
      // Anchor captured from v1, where the button really was #load-btn.
      const spec = flow(mutated.url)
      const step = spec.steps[2]
      if (step?.action !== "click") throw new Error("expected click")
      step.target.anchor = {
        role: "button", name: "Load invoices", nameNormalized: "load invoices",
        attrs: { testId: null, name: "load", type: "button" },
        nearText: ["Export CSV"], landmarks: ["main", "section[Invoices]"],
        siblingOrdinal: 0, siblingRole: "button",
        textFingerprint: ["load", "invoices"],
      }

      const result = await runFlow(spec, { month: "2026-08" }, {
        backend: localBackend(),
        healer: null, // deliberately no healer: this must be free
      })

      expect(result.status).toBe("ok")
      expect(result.telemetry.llmCalls).toBe(0)
      expect(result.telemetry.costUsd).toBe(0)
      const healed = result.steps.find((s) => s.stepId === "s2")
      expect(healed?.status).toBe("healed")
      expect(healed?.tier).toBe("anchor")
      expect(healed?.selectorUsed).toBe("#btn-load")
      expect(result.repaired?.version).toBe(2)
    } finally {
      await mutated.close()
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/runtime.test.ts -t "id rename"`
Expected: FAIL — the variant does not exist yet, or the step reports `failed`.

- [ ] **Step 4: Make it pass**

No new production code should be needed — Tasks 6 and 9 already implement this path. If the
test fails on the score threshold, do **not** lower `ACCEPT_SCORE`; instead check that
`observe.ts` is populating `attrs.name` and `nearText`, since those are the terms carrying the
match once the id is gone.

Run: `cd understudy && npx vitest run test/runtime.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add understudy/demo-site/v2-id-rename understudy/test/runtime.test.ts
git commit -m "test(understudy): id rename heals for free via anchor scoring"
```

---

### Task 11: The isolation test

Makes "replay cannot spend money" a property of the code rather than a claim in a README.

**Files:**
- Create: `understudy/test/isolation.test.ts`

- [ ] **Step 1: Write the test**

`understudy/test/isolation.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src")

/** Follow relative imports from an entry file and return every module reached. */
function transitiveImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen
  seen.add(entry)
  const source = readFileSync(entry, "utf8")
  for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const spec = match[1]!
    const resolved = join(dirname(entry), spec.replace(/\.js$/, ".ts"))
    try {
      transitiveImports(resolved, seen)
    } catch {
      // Not a local file (or type-only). Ignore.
    }
  }
  return seen
}

const FORBIDDEN = ["@anthropic-ai/sdk", "llm.ts", "cassette.ts"]

describe("runtime isolation", () => {
  it("cannot reach an LLM client, directly or transitively", () => {
    const reached = [...transitiveImports(join(srcDir, "runtime.ts"))]
    const offenders = reached.filter((f) => FORBIDDEN.some((bad) => f.endsWith(bad)))
    expect(offenders).toEqual([])

    for (const file of reached) {
      const source = readFileSync(file, "utf8")
      expect(source).not.toContain("@anthropic-ai/sdk")
    }
  })
})
```

- [ ] **Step 2: Run it**

Run: `cd understudy && npx vitest run test/isolation.test.ts`
Expected: PASS. (It passes today because no LLM code exists — its job is to *keep* passing once
Plan 2 adds `llm.ts`.)

- [ ] **Step 3: Commit**

```bash
git add understudy/test/isolation.test.ts
git commit -m "test(understudy): runtime is structurally unable to call an LLM"
```

---

### Task 12: The committed artifact and a green suite

**Files:**
- Create: `understudy/flows/invoice-export.json`
- Modify: `understudy/test/runtime.test.ts` (append)

- [ ] **Step 1: Write the artifact**

`understudy/flows/invoice-export.json` — hand-written here; Plan 2's compiler emits it. The
`url` is a placeholder that tests overwrite with the ephemeral demo-site port.

```json
{
  "name": "invoice-export",
  "version": 1,
  "url": "http://127.0.0.1:8787/",
  "backend": "local",
  "profile": null,
  "inputs": { "month": { "type": "string", "required": true } },
  "steps": [
    { "id": "s0", "action": "goto", "url": "http://127.0.0.1:8787/" },
    {
      "id": "s1", "action": "fill", "value": "{{month}}",
      "target": {
        "primary": "#month", "fallbacks": ["input[name=month]"], "history": [],
        "anchor": {
          "role": "textbox", "name": "Billing month", "nameNormalized": "billing month",
          "attrs": { "testId": null, "name": "month", "type": "text" },
          "nearText": ["Invoices", "Load invoices"],
          "landmarks": ["main", "section[Invoices]"],
          "siblingOrdinal": 0, "siblingRole": "textbox",
          "textFingerprint": ["billing", "month", "invoices"]
        }
      },
      "postcondition": { "type": "domChanged" }
    },
    {
      "id": "s2", "action": "click",
      "target": {
        "primary": "#load-btn", "fallbacks": ["button[name=load]"], "history": [],
        "anchor": {
          "role": "button", "name": "Load invoices", "nameNormalized": "load invoices",
          "attrs": { "testId": null, "name": "load", "type": "button" },
          "nearText": ["Export CSV"],
          "landmarks": ["main", "section[Invoices]"],
          "siblingOrdinal": 0, "siblingRole": "button",
          "textFingerprint": ["load", "invoices"]
        }
      },
      "postcondition": { "type": "selectorVisible", "value": "#results" }
    },
    {
      "id": "s3", "action": "extract", "as": "status",
      "target": {
        "primary": "#status", "fallbacks": [], "history": [],
        "anchor": {
          "role": "generic", "name": "", "nameNormalized": "",
          "attrs": { "testId": null, "name": null, "type": null },
          "nearText": ["Load invoices", "Export CSV"],
          "landmarks": ["main", "section[Invoices]"],
          "siblingOrdinal": 0, "siblingRole": "generic",
          "textFingerprint": []
        }
      },
      "postcondition": { "type": "textPresent", "value": "results" }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Append to `understudy/test/runtime.test.ts`:

```ts
import { loadFlow } from "../src/spec.js"

describe("the committed artifact", () => {
  it("parses and runs green against the demo site", async () => {
    const onDisk = loadFlow(new URL("../flows/invoice-export.json", import.meta.url).pathname)
    const rebased = {
      ...onDisk,
      url: server.url,
      steps: onDisk.steps.map((s) => (s.action === "goto" ? { ...s, url: server.url } : s)),
    }
    const result = await runFlow(rebased, { month: "2026-08" }, {
      backend: localBackend(), healer: null,
    })
    expect(result.status).toBe("ok")
    expect(result.telemetry.llmCalls).toBe(0)
    expect(result.output.status).toContain("3 results")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd understudy && npx vitest run test/runtime.test.ts -t "committed artifact"`
Expected: FAIL — the flow file does not exist yet.

- [ ] **Step 4: Run the full suite**

Run: `cd understudy && npm test`
Expected: PASS — all 5 test files, 22 tests.

- [ ] **Step 5: Typecheck**

Run: `cd understudy && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add understudy/flows/invoice-export.json understudy/test/runtime.test.ts
git commit -m "feat(understudy): committed flow artifact running green end to end"
```

---

## Done when

- `npm test` is green: 22 tests across 5 files.
- `npx tsc --noEmit` is clean.
- The runtime executes a committed `flow.json` against a real browser with `llmCalls: 0`.
- An `id-rename` mutation heals **for free**, and the test asserts it cost `$0`.
- `isolation.test.ts` guarantees the runtime cannot reach an LLM client.
- Total spend to reach this point: **$0**.

## What Plan 2 picks up

`llm.ts` with the cassette layer, `heal.ts` implementing the `Healer` interface already defined
in `src/backends/types.ts`, `learn.ts` and `compile.ts` to produce artifacts instead of
hand-writing them, and the CLI. The isolation test must stay green throughout.
