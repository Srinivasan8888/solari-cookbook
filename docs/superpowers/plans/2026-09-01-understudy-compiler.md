# Understudy — Plan 2: The Compiler and the Healer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce flow artifacts from an English goal, and repair the drift that free anchor scoring correctly refuses to guess at.

**Architecture:** A provider-agnostic `LlmClient` wrapped in a cassette layer, with a model fallback chain underneath. `heal.ts` implements the `Healer` interface Plan 1 already declared; `learn.ts` + `compile.ts` produce the `flow.json` that Plan 1 hand-wrote. `runtime.ts` is not modified — the seam already exists.

**Tech Stack:** OpenRouter (free tier), strict JSON schema output, Zod validation. No native tool-calling.

**Cost: ~$0.** OpenRouter free models. Cassettes make every re-run free after the first.

---

## What execution of Plan 1 taught us, which this plan encodes

Three findings from building and probing, all load-bearing here:

1. **The free tier is unreliable.** Racing four free models on the real heal task: one passed, two returned provider errors ("Service temporarily overloaded"), one was too weak to answer. A single-model healer would fail randomly. **The fallback chain is not a nicety; it is the minimum viable design on this provider.**

2. **The anchor boundary is real and measured.** On the `v2-redesign` mutation (id + label + `name` attribute all changed at once) free scoring ranked the correct element *first* but at `0.628` — below the 0.80 accept threshold. It declined to guess and escalated. That is the exact case this plan's healer must solve.

3. **Vitest hides bugs that `tsx` exposes.** The `__name` crash passed 23 unit tests. Any new module reached from the CLI needs an integration test that actually shells out to `tsx`.

## Measured baseline to beat

| | |
|---|---|
| Snapshot size | 2,229 bytes / 6 nodes |
| Heal prompt | 674 input tokens |
| Heal completion | 531 output tokens |
| Heal latency | ~6.5s on `dots-3-note-preview:free` |
| Free-tier accept threshold | 0.80, margin 0.15 |
| `v2-redesign` free score | 0.628 → escalates |

---

## File structure

```
understudy/
  src/
    llm.ts          LlmClient interface, OpenRouter adapter, model fallback chain
    cassette.ts     Record/replay wrapper around any LlmClient
    heal.ts         Healer implementation (satisfies backends/types.ts)
    compile.ts      Trace -> FlowSpec, with anchor extraction (pure)
    learn.ts        Agentic loop: observe -> JSON action -> act -> repeat
    cli.ts          learn | run | diff
  fixtures/
    cassettes/      Committed. Makes the suite free and deterministic.
  test/
    llm.test.ts  cassette.test.ts  heal.test.ts  compile.test.ts  cli.test.ts
```

`runtime.ts` is untouched. `isolation.test.ts` must stay green — it will now be
guarding against a real `llm.ts` rather than a hypothetical one.

---

### Task 1: LlmClient and the fallback chain

**Files:** Create `src/llm.ts`, `test/llm.test.ts`

Interface:

```ts
export type LlmRequest = { system?: string; prompt: string; schema: object; maxTokens?: number }
export type LlmResponse<T> = {
  value: T; model: string; inputTokens: number; outputTokens: number; costUsd: number
}
export interface LlmClient { complete<T>(req: LlmRequest): Promise<LlmResponse<T>> }
```

- [ ] **Step 1: Write the failing test** — `test/llm.test.ts`, using an injected `fetchImpl` so no network is touched:

```ts
import { describe, expect, it, vi } from "vitest"
import { openRouterClient } from "../src/llm.js"

const ok = (content: unknown, model = "m1") => ({
  ok: true,
  json: async () => ({
    model,
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
})
const providerError = () => ({ ok: true, json: async () => ({ error: { message: "overloaded" } }) })

const req = { prompt: "p", schema: { type: "object" } }

describe("openRouterClient", () => {
  it("returns the parsed value and usage from the first model that answers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ idx: 3 }))
    const client = openRouterClient({ apiKey: "k", models: ["m1", "m2"], fetchImpl: fetchImpl as never })
    const res = await client.complete<{ idx: number }>(req)
    expect(res.value.idx).toBe(3)
    expect(res.inputTokens).toBe(10)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("falls through to the next model when a provider errors", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(providerError())
      .mockResolvedValueOnce(ok({ idx: 7 }, "m2"))
    const client = openRouterClient({ apiKey: "k", models: ["m1", "m2"], fetchImpl: fetchImpl as never })
    const res = await client.complete<{ idx: number }>(req)
    expect(res.value.idx).toBe(7)
    expect(res.model).toBe("m2")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("falls through when a model returns unparseable JSON", async () => {
    const bad = { ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }
    const fetchImpl = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok({ idx: 1 }, "m2"))
    const client = openRouterClient({ apiKey: "k", models: ["m1", "m2"], fetchImpl: fetchImpl as never })
    expect((await client.complete<{ idx: number }>(req)).value.idx).toBe(1)
  })

  it("throws with every model's failure listed once the chain is exhausted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(providerError())
    const client = openRouterClient({ apiKey: "k", models: ["m1", "m2"], fetchImpl: fetchImpl as never })
    await expect(client.complete(req)).rejects.toThrow(/m1.*m2/s)
  })

  it("reports zero cost for :free models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ idx: 0 }, "x:free"))
    const client = openRouterClient({ apiKey: "k", models: ["x:free"], fetchImpl: fetchImpl as never })
    expect((await client.complete(req)).costUsd).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/llm.test.ts` → `Cannot find module '../src/llm.js'`
- [ ] **Step 3: Implement `src/llm.ts`.** Requirements, each one earned by the probe:
  - `complete()` walks `models` in order. A model is "failed" if the HTTP call throws, `res.ok` is false, the body carries `error`, there is no message content, or the content does not `JSON.parse`.
  - Accumulate failures; when the chain is exhausted, throw one error naming **every** model and its reason. A silent generic failure would be untraceable at 3am.
  - Request body: `{ model, messages: [...], response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }, max_tokens }`.
  - `costUsd` is `0` for any model id ending `:free`; otherwise `0` (real pricing is Plan 3's problem, and claiming a number we did not compute would be worse than reporting zero).
  - `fetchImpl` defaults to global `fetch`, injectable for tests.
- [ ] **Step 4: Run to verify it passes.** Expected: 5 passed.
- [ ] **Step 5: Commit.** `git commit -m "feat(understudy): LLM client with model fallback chain"`

---

### Task 2: Cassettes

**Files:** Create `src/cassette.ts`, `test/cassette.test.ts`

- [ ] **Step 1: Write the failing test.** Cover: record writes a file; replay serves from it without calling the inner client; a replay miss throws rather than silently calling the network (a silent fallthrough would spend money in CI); `off` always delegates.

```ts
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cassetteClient } from "../src/cassette.js"
import type { LlmClient } from "../src/llm.js"

const inner = (value: unknown): LlmClient & { calls: number } => {
  const c = {
    calls: 0,
    async complete() {
      c.calls++
      return { value, model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0 } as never
    },
  }
  return c as never
}
const req = { prompt: "find the button", schema: { type: "object" } }

describe("cassetteClient", () => {
  it("records, then replays without touching the inner client", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cass-")), "c.json")
    const rec = inner({ idx: 4 })
    await cassetteClient(rec, { mode: "record", path }).complete(req)
    expect(rec.calls).toBe(1)

    const play = inner({ idx: 999 })
    const res = await cassetteClient(play, { mode: "replay", path }).complete<{ idx: number }>(req)
    expect(res.value.idx).toBe(4)
    expect(play.calls).toBe(0)
  })

  it("throws on a replay miss rather than silently spending money", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cass-")), "c.json")
    const c = cassetteClient(inner({}), { mode: "replay", path })
    await expect(c.complete({ prompt: "unseen", schema: {} })).rejects.toThrow(/cassette miss/i)
  })

  it("delegates every call when off", async () => {
    const rec = inner({ idx: 1 })
    const c = cassetteClient(rec, { mode: "off", path: "/nope" })
    await c.complete(req)
    await c.complete(req)
    expect(rec.calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Key = SHA-256 of `JSON.stringify({ system, prompt, schema })`. Store `{ [key]: LlmResponse }` as pretty JSON so cassettes diff readably in review. Replay miss throws `cassette miss: <key prefix>` naming the prompt's first 60 chars.
- [ ] **Step 4: Run to verify it passes.** Expected: 3 passed.
- [ ] **Step 5: Commit.**

---

### Task 3: The healer

**Files:** Create `src/heal.ts`, `test/heal.test.ts`

- [ ] **Step 1: Write the failing test** using a stub `LlmClient` — no network, no cassette:

```ts
import { describe, expect, it } from "vitest"
import { llmHealer } from "../src/heal.js"
import type { LlmClient } from "../src/llm.js"
import type { Snapshot } from "../src/observe.js"
import type { Anchor } from "../src/spec.js"

const anchor: Anchor = {
  role: "button", name: "Export CSV", nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices"], landmarks: ["main"], siblingOrdinal: 1,
  siblingRole: "button", textFingerprint: ["export", "csv"],
}
const snapshot: Snapshot = {
  url: "http://x/",
  nodes: [
    { idx: 0, role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null }, nearText: [], landmarks: ["nav"],
      siblingOrdinal: 0, siblingRole: "link", textFingerprint: ["settings"], selector: "#settings-tab" },
    { idx: 1, role: "button", name: "Download report", nameNormalized: "download report",
      attrs: { testId: null, name: "download", type: "submit" }, nearText: ["Invoices"],
      landmarks: ["main"], siblingOrdinal: 1, siblingRole: "button",
      textFingerprint: ["download", "report"], selector: "#cta-download" },
  ],
}
const stub = (value: unknown): LlmClient => ({
  async complete() {
    return { value, model: "stub", inputTokens: 674, outputTokens: 531, costUsd: 0 } as never
  },
})

describe("llmHealer", () => {
  it("maps the chosen idx back to a selector", async () => {
    const res = await llmHealer(stub({ idx: 1, confidence: 0.9 }))
      .heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(res?.selector).toBe("#cta-download")
  })

  it("returns null for an idx that is not in the snapshot", async () => {
    const res = await llmHealer(stub({ idx: 42, confidence: 0.9 }))
      .heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(res).toBeNull()
  })

  it("returns null below the confidence floor rather than guessing", async () => {
    const res = await llmHealer(stub({ idx: 1, confidence: 0.1 }))
      .heal({ anchor, snapshot, failedSelector: "#export-btn" })
    expect(res).toBeNull()
  })

  it("returns null when the chain is exhausted, so the run fails loudly", async () => {
    const throwing: LlmClient = { async complete() { throw new Error("all models failed") } }
    const res = await llmHealer(throwing).heal({ anchor, snapshot, failedSelector: "#x" })
    expect(res).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Sends only `{ idx, role, name, attrs, nearText }` per node — never raw HTML, never selectors (the model picks an index, so it cannot invent a selector). Confidence floor `0.5`. Any thrown error becomes `null`, because the runtime's contract is that a failed heal fails the step loudly rather than propagating an exception.
- [ ] **Step 4: Run to verify it passes.** Expected: 4 passed.
- [ ] **Step 5: Commit.**

---

### Task 4: End-to-end heal against the redesign

The case free scoring measured at 0.628 and refused.

**Files:** Modify `test/runtime.test.ts`, create `fixtures/cassettes/heal-redesign.json`

- [ ] **Step 1: Write the failing test** — run the flow against `v2-redesign` with a cassette-backed healer, asserting `tier === "llm"`, `llmCalls === 1`, and that the postcondition verified the repair.
- [ ] **Step 2: Record the cassette once** with `UNDERSTUDY_CASSETTE=record` and a live key. This is the only step in Plan 2 that touches the network.
- [ ] **Step 3: Commit the cassette**, then confirm the test passes with the key unset — proving the suite is free and offline.
- [ ] **Step 4: Commit.**

---

### Task 5: Compile — trace to artifact

**Files:** Create `src/compile.ts`, `test/compile.test.ts`

- [ ] **Step 1: Write the failing test.** A trace is `{ action, idx, value?, urlBefore, urlAfter, snapshotBefore, snapshotAfter }[]`. Assert: anchors are lifted from the snapshot node verbatim; `fallbacks` are generated (`[name=x]`, `role=`/name); a postcondition is inferred (`urlContains` when the URL changed, `selectorVisible` when a new node appeared, else `domChanged`); the result parses under `FlowSpecSchema`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Pure function, no browser, no network. **Every healable step gets a postcondition** — `domChanged` is the floor, never omission, because `StepSchema` refuses to parse otherwise.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 6: Learn — the agentic loop

**Files:** Create `src/learn.ts`, `test/learn.test.ts`

- [ ] **Step 1: Write the failing test** driving a scripted `LlmClient` (fill → click → done) against the live demo site, asserting the emitted spec parses and then *runs green* through `runFlow`. The compiler's output being executable is the only assertion that matters.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** One strict-JSON action per turn — `{ action, idx, value?, done, reasoning }` — **not** native tool-calling, which the probe showed free models handle unreliably. Hard caps: `maxTurns` default 25, and `UNDERSTUDY_MAX_SPEND_USD` default 2.00 checked before every call. Each turn appends to the trace; `done` or the cap ends the loop and hands the trace to `compile`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 7: CLI

**Files:** Create `src/cli.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write the failing test** shelling out to `tsx src/cli.ts run invoice-export --input month=2026-08` and asserting exit 0 plus `llmCalls 0` on stderr. **This must shell out to `tsx`** — Task 3 of Plan 1's postmortem: vitest's transform hides the `__name` class of bug.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `learn`, `run`, `diff`. `run` prints `formatTelemetry` to stderr and JSON output to stdout, so it pipes. `--heal` is opt-in; without it the healer is `null`. `--no-heal` is the explicit form. Exit non-zero on flow failure.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 8: Guards

**Files:** Modify `src/learn.ts`, `src/cli.ts`; create `test/guards.test.ts`

- [ ] **Step 1: Write the failing test.** Assert the loop stops at `maxTurns`; assert it aborts when projected spend exceeds `UNDERSTUDY_MAX_SPEND_USD`; assert a second heal failure on one step **stops and reports** rather than escalating (spec §5, and the reason escalation is opt-in).
- [ ] **Step 2–4: Run, implement, run.**
- [ ] **Step 5: Commit.**

---

## Done when

- `npm test` green with **no API key set** — cassettes carry every LLM interaction.
- `understudy run invoice-export` prints `llmCalls 0`.
- `understudy run` against `v2-redesign` with `--heal` repairs the step the free tier measured at 0.628, verifies it with a postcondition, and writes an auditable history entry.
- `isolation.test.ts` still green, now guarding against a real `llm.ts`.
- The CLI is exercised through `tsx`, not only through vitest.
- Total spend: **~$0**.

## What Plan 3 picks up

`bench` (B1/B2/B3 and the ten-class drift corpus), `drift` plus the GitHub Action, `serve`, the Solari backend, the README with measured numbers, and the distilled upstream example.
