# Understudy — design

**Date:** 2026-09-01
**Status:** approved for planning
**One line:** A compiler for web tasks. The LLM is the compiler, not the runtime.

```
goal + site   ──▶  compiler   ──▶  flow.json   ──▶  runtime    ──▶  result
  (source)          (LLM, once)      (artifact)     (deterministic,
                                                     zero LLM)
                         ▲                               │
                         └──── incremental recompile ◀────┘
                              (one step, on drift)
```

Understudy is not an agent that browses. It is a compiler whose target is a deterministic
program, plus a runtime that executes it, plus an incremental recompiler that touches one
step when the source language — the website — changes underneath it.

This framing is load-bearing and it governs the vocabulary throughout: **source, compiler,
artifact, runtime, recompile.** An agent that gets faster is a nice optimization. A compiler
is a different category of thing, and it is the honest description of what this does.

---

## 1. Problem

Web agents are 10–100× too slow and too expensive to put on a cron. A nightly export that a Playwright script does in 4 seconds for nothing takes an agent 40 seconds and real money, every night, forever — and it re-derives the same answer each time.

Plain Playwright is the opposite failure. It is fast and free until someone renames a CSS class, and then it is silently broken until a human notices.

Both fail for the same reason: they treat "find the element" as a per-run problem. It isn't. It is a per-*change* problem. Sites change rarely; scripts run constantly.

**Understudy separates the two.** Pay for intelligence once, at learn time. Compile the result into a deterministic program. Replay it for free. Spend a small amount of intelligence again only when, and only where, the page actually moved.

## 2. Non-goals

- Not a general web agent. It executes learned flows; it does not improvise at run time.
- Not a scraper framework. Extraction is one step type, not the product.
- Not a hosted service. It is a CLI plus a small local server.
- No desktop/VNC support. There is no honest role for one here, and adding it to touch a third product would be decoration. Stated explicitly in the README.

## 3. Architecture

Four commands over one artifact.

| Command | Cost | What it does |
|---|---|---|
| `understudy learn "<goal>" --url <url>` | expensive, once | LLM drives the browser, emits `flows/<name>.json` (`--name`, else a slug of the goal) |
| `understudy run <name> --input k=v` | **$0 on the happy path** | Deterministic replay; prints `llmCalls: 0` unless a step drifted and healed |
| `understudy serve` | $0 | `POST /flows/:name` — typed JSON in, typed JSON out |
| `understudy drift` | **$0, always** | Runs every flow with healing **off**; exits non-zero on breakage. The CI command |
| `understudy diff <name>` | $0 | Selector-level history of every automatic repair, with the run that triggered it |
| `understudy bench` | ~$0.03 | Produces `benchmarks.json` — the artifact that proves the thesis (§11) |

Dataflow:

```
goal + url ──learn──▶ trace ──compile──▶ flow.json ──run──▶ result
                                            ▲               │
                                            └───heal────────┘  (only on failure)
```

`compile`, `heal`, and `spec` are pure functions over data. The browser and the LLM are both injected at the edges. This is what makes the project testable — and buildable — with no network and no credentials.

**Hard rule:** `run.ts` must not import `llm.ts`. The replay engine calls out through an injected `Healer` interface, which is `null` under `--no-heal`. Enforced by a lint rule and a test.

So the zero-cost claim is precise and structural: **a run that does not heal cannot make an LLM call, because the code path does not exist.** A run that heals reports exactly what it spent.

## 4. The flow spec

The central artifact. Committed to git, diffable, human-editable.

```jsonc
{
  "name": "invoice-export",
  "version": 3,
  "url": "https://portal.example.com",
  "backend": "local",
  "profile": null,
  "inputs": { "month": { "type": "string", "required": true } },
  "steps": [
    {
      "id": "s3",
      "action": "click",
      "target": {
        "primary": "#export-btn",
        "fallbacks": ["role=button[name='Export CSV']", "text=Export"],
        "anchor": {
          "role": "button",
          "name": "Export CSV",
          "nameNormalized": "export csv",
          "attrs": { "testId": null, "name": "export", "type": "submit" },
          "nearText": ["Invoices", "August 2026", "12 results"],
          "landmarks": ["main", "region[Invoices]"],
          "siblingOrdinal": 2,
          "siblingRole": "button",
          "textFingerprint": ["export", "csv", "download"]
        }
      },
      "postcondition": { "type": "urlContains", "value": "/download" },
      "history": []
    }
  ],
  "output": { "type": "object", "properties": { "rows": { "type": "array" } } }
}
```

### The one non-obvious decision

A step stores a **semantic anchor**, not just a selector. Four independent layers, captured at
compile time, so that no single change to the page destroys all of them at once:

| Layer | Field | Survives |
|---|---|---|
| Semantic | `role`, `name`, `nameNormalized` | restyling, id churn, class churn |
| Attribute | `attrs.testId`, `attrs.name`, `attrs.type` | relabelling, i18n |
| Contextual | `nearText`, `landmarks` | relabelling *and* id churn together |
| Structural | `siblingOrdinal`, `siblingRole` | full relabelling, icon-only redesigns |

`textFingerprint` is a normalized token set used to score candidates when several plausibly match.

The layering is the point. A rename kills `name` but not `attrs` or `siblingOrdinal`. A redesign
kills structure but not `role` + `nearText`. Healing is asked to reconcile four weak signals
rather than trust one strong one.

This is what turns healing from *"re-run the agent and hope"* into a narrow, single-shot, verifiable question: *given this anchor, which element on the current page is it?* Narrow questions are cheap questions. The entire cost model of the project rests on this field.

### Step types

`goto` · `click` · `fill` · `select` · `waitFor` · `extract` · `assert`

**Every step that can be healed must carry a `postcondition`.** Schema-enforced, not a
convention: the compiler refuses to emit a healable step without one, because a heal with
nothing to verify against is a guess that reports itself as a success. Where the compiler
cannot infer a postcondition, it emits a DOM-delta assertion (the step must change *something*
observable) rather than nothing.

Otherwise deliberately small. Anything not expressible in these seven is a signal the flow should be split, not that the vocabulary should grow.

## 5. Healing

On step failure (selector miss, timeout, or failed postcondition):

1. Try `fallbacks` in order — free, no LLM.
2. Capture a compact snapshot of the page (§7).
3. **One** LLM call: anchor + snapshot → new selector. Claude Haiku 4.5, `effort: "low"`.
4. Retry the step.
5. **Verify the postcondition.** A heal that isn't verified is a guess.
6. On success: patch the spec, bump `version`, push the old selector to `history` with a timestamp and the replay URL of the run where it broke.
7. On a second failure: **stop, report, exit non-zero.** Do not escalate.

### Two rules that bound the cost of failure

**Healing is strictly local.** One step, one call, one retry. It never re-runs the compiler over
the whole flow, and it never touches a step that did not fail. The blast radius of a repair is
exactly one `steps[i].target`.

**Escalation is opt-in.** A second failure exits with a report, not with a full agent run.
`--escalate` enables recompilation of the remainder, and even then it is bounded by
`UNDERSTUDY_MAX_SPEND_USD`.

The reasoning is that a failure is the *worst* moment to start spending without a ceiling:
you know the least about what is happening, and the cost is unbounded exactly when the
situation is least understood. Silent recovery that costs a dollar is worse than a loud stop
that costs nothing — the loud stop is information, and it is what `drift` is built on.

Healing is verified, never trusted. `--no-heal` makes the runtime detect drift instead of
absorbing it — that is what `drift` uses, and why `drift` can never spend money.

## 6. Backends

One interface, two implementations. Same spec, same engine.

| | `local` (default) | `solari` |
|---|---|---|
| Cost | $0 | ~$0.15/browser-hour |
| Stay logged in across runs | manual `storageState` juggling | `profileId` — a first-class object |
| Reach sites that block datacenter IPs | no | `stealth` + `proxy` |
| Audit trail | screenshots you wire yourself | `recording: true` + a shareable replay URL |
| Parallel `drift` across all flows | bounded by your laptop | horizontal |

Solari exposes `wsEndpoint` and `cdpEndpoint` and is Playwright-compatible, so the adapter is genuinely thin — both branches hand back the same Playwright `Browser`.

Precedence is fixed: `--backend` on the command line beats the spec's `backend` field, which beats the `local` default. A flow learned locally therefore runs against Solari without editing the spec.

The README carries this table honestly. Solari is the deployment target, not the dependency; that is a feature, not a hedge.

### Credentials, and why the replay is safe

Solari records **input values by default, including passwords**. Understudy never types a credential: you populate a profile once in the Solari console's live browser editor (which handles 2FA and captcha with a human), and flows attach `profileId`. So the replay cannot contain a secret, because a secret was never typed.

This started as a workaround for a recording gotcha and ended up being the right design. It is a stated security property in the README.

## 7. Token discipline (the largest cost lever)

**Never send raw HTML to the model.** `observe.ts` prunes the accessibility tree to interactive and labelled elements only — role, accessible name, nearby text, a stable index — capped at 120 nodes, hard-capped at 1,500 tokens.

Roughly 20× cheaper than raw DOM per turn, and it makes the model's job easier, not harder: it is being asked to pick from a list, not to parse a document.

Additional levers, all defaults rather than flags:

- **Prompt caching** on the system prompt and tool definitions (stable prefix; volatile snapshot last).
- **`--max-turns 25`** plus a `task_budget` on the learn loop, so a runaway agent cannot quietly spend $20.
- **`UNDERSTUDY_MAX_SPEND_USD`** (default `2.00`) — abort a run whose projected spend exceeds it.
- **`effort: "low"`** on heal, `"medium"` on learn.

## 8. Cassettes

`llm.ts` sits behind a record/replay layer.

- `UNDERSTUDY_CASSETTE=record` — write every request/response pair to `fixtures/cassettes/`.
- `UNDERSTUDY_CASSETTE=replay` (default when a cassette exists) — serve from disk, zero network, zero cost.
- `UNDERSTUDY_CASSETTE=off` — always live.

Consequence: the first real `learn` costs money; every iteration after it is free and deterministic. The whole test suite runs offline with no API key.

This exists for test determinism first and cost second — but it happens to be the single biggest reason this project is cheap to build.

## 9. Models

| Path | Model | Why |
|---|---|---|
| `learn` (iterating) | `claude-sonnet-5` | ~60% cheaper; the loop is cassetted after the first run anyway |
| `learn` (published flows) | `claude-opus-5` via `--model` | The artifact you ship should be learned by the strongest model |
| `heal` | `claude-haiku-4-5` | A narrow question with the anchor handed to it. Makes "repair is cheap" literally true |

Adaptive thinking throughout (`thinking: {type: "adaptive"}`). Sonnet 5 as the learn default is a deliberate cost choice made at the user's explicit request; `--model` overrides it in one flag.

## 10. Demo

`demo-site/` is a fragile invoice portal, committed in two variants:

- **v1** — `#invoices-tab`, `#month`, `#export-btn`
- **v2** — ids renamed, the button relabelled `Export CSV` → `Download report` and buried in a dropdown

Served from a Solari sandbox preview URL when a key exists; plain `node:http` otherwise.

`understudy demo` runs the whole arc in ~90 seconds: **learn → run fast → break the site → run fails → heal → run fast again.**

Deterministic and self-hosted, so you can shoot the video twice and there is no third party's ToS involved.

## 11. The benchmark — this is the deliverable

Everything else in this document exists to make this table possible. It is the artifact that
proves the thesis, and it is what the README opens with. `understudy bench` writes
`benchmarks.json`; it is committed and regenerated by real runs.

### Per-run telemetry

Every command emits: replay latency (p50/p95), heal latency, LLM calls, input/output tokens,
dollars, and pass/fail. Written to `benchmarks.json`, printed as one line to stderr.
Replay latency and heal latency are reported **separately** — averaging them together would
hide the entire point.

### B1 — The thesis run

100 consecutive runs of `invoice-export` against demo-site v1.

**Asserted, not observed:** `llmCalls === 0` and `costUsd === 0` across all 100. The test fails
the build otherwise. This is cheap to assert because it is structurally guaranteed (§3), and
asserting it anyway is what turns a design claim into a test.

Cost: **$0.00** — local Chromium against a site we host.

### B2 — The drift corpus

The interesting half, and the one that can embarrass us.

Ten mutation classes, each a committed variant of the demo site, each run 5 times:

| # | Class | What changes |
|---|---|---|
| 1 | `id-rename` | `#export-btn` → `#btn-export` |
| 2 | `class-churn` | utility classes regenerated wholesale |
| 3 | `label-change` | "Export CSV" → "Download report" |
| 4 | `i18n` | all labels translated to French |
| 5 | `reparent` | button moved inside a dropdown menu |
| 6 | `reorder` | siblings reordered |
| 7 | `role-change` | `<button>` → `<a role="button">` |
| 8 | `icon-only` | text replaced by an icon plus `aria-label` |
| 9 | `shadow-dom` | component wrapped in a shadow root |
| 10 | `ambiguous` | a second, near-identical button added as a decoy |

Reported per class: heal success rate, LLM calls, tokens, latency, cost.

Class 10 is expected to fail, or to heal to the wrong element. **Publishing that is the point.**
A table where every class scores 100% reads as a table that was not really run. The failure
rows are what make the passing rows believable, and knowing *which* drift classes defeat the
anchor is the most useful thing this project can tell anyone.

Cost: 10 × 5 = 50 Haiku calls ≈ **$0.03**.

### B3 — The recovery

100 more runs immediately after a heal. Asserted: back to `llmCalls === 0`.

This closes the loop. Without B3 the story is "it recovers"; with B3 the story is
**"it recovers and then stops costing anything again,"** which is the actual claim.

### The headline

```
100 runs     0 LLM calls    $0.0000    p50 3.9s
site change  1 LLM call     $0.0004    +1.2s
100 runs     0 LLM calls    $0.0000    p50 3.9s

heal success  43/50 across 10 mutation classes
              fails: ambiguous (0/5), shadow-dom (3/5)
```

If the numbers come out worse than that, the README prints the worse numbers. A benchmark you
would not publish when it disappoints you is not a benchmark.

### Drift as a CI feature

`understudy drift` is the same runtime with the healer set to `null`, so it **cannot** spend
money — not "is configured not to," cannot. It exits non-zero on breakage and writes a
machine-readable report.

Shipped with a GitHub Action that runs it on a schedule: free breakage detection for every
flow, on a cron, with no LLM spend. Repair stays a deliberate act — a human runs `understudy
run --heal` and reviews the resulting diff.

### Auditability

`understudy diff <name>` prints selector-level history: every automatic repair, what changed,
which run triggered it, the model and cost, and the postcondition that verified it. Each
repair bumps `version` and appends to `history`; because flows are committed JSON, a repair
also shows up as a reviewable line in `git diff`. No repair is invisible.

## 12. Testing

TDD on the pure core, which is where the actual logic lives:

- `compile.test.ts` — trace → spec, including anchor extraction
- `heal.test.ts` — anchor + v2 snapshot → correct selector, against committed fixtures
- `spec.test.ts` — versioning, history, round-trip
- `isolation.test.ts` — asserts `run.ts` has no transitive import of `llm.ts`

Fixtures: `fixtures/pages/{v1,v2}.html` and recorded cassettes. Zero network, zero credentials, zero cost.

The browser adapters are thin and verified manually once against each backend.

## 13. Layout

```
understudy/
  src/{cli,spec,observe,learn,compile,run,heal,llm,cassette,server,cost}.ts
  src/backends/{index,local,solari}.ts
  flows/invoice-export.json
  demo-site/{v1,v2}/index.html  demo-site/serve.ts
  fixtures/{cassettes,pages}/
  test/
  README.md
```

Lives as a top-level directory in the fork. `examples/` stays untouched.

## 14. Shipping

1. `understudy/` in the public fork, with a README that leads with the measured numbers.
2. Upstream PR to `solari-sdk/solari-cookbook`: `examples/browser-self-healing-selector-ts`.

   Deliberately tiny — the cookbook's stated rule is "one idea each, no framework, no
   scaffolding to read past," and this example obeys it rather than advertising Understudy.
   Four beats, ~70 lines: **broken selector → Haiku call → repaired selector → postcondition
   verifies it.** No spec format, no CLI, no compiler vocabulary. Anyone should be able to lift
   it into their own Playwright script in five minutes.

   Per the cookbook's contributing note, the surprising part gets a comment where it bites:
   healing without a postcondition is a guess that reports success.
3. Possible second upstream issue/PR: the cookbook's `sandbox-quickstart-ts` imports `@solarisdk/sdk` while the docs say `@solarisdk/sandbox`, and both the browser and sandbox packages export a class named `Solari` — a collision that bites anyone importing both in one file, as Understudy does.

## 15. Budget

| | Estimate |
|---|---|
| Solari | ~$0.64, inside the $3 free tier |
| Anthropic, with cassettes + Haiku heal + Sonnet learn | ~$8 |
| Minimum to start | $5 (Anthropic minimum top-up) |

Claude Code subscriptions do not cover API usage; this is separate billing.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Anchors too weak to survive a real redesign | v2 is a deliberately harsh redesign; if healing fails there, strengthen the anchor before shipping |
| Agent learns a flow that is subtly wrong | Postconditions on every step; `learn` prints the compiled spec for review before it is saved |
| Solari SDK behaves differently than documented | Backend adapter is ~100 lines and isolated; local backend keeps the project working regardless |
| Scope creep into a general agent framework | The seven step types are a fixed budget |
