# Understudy — design

**Date:** 2026-09-01
**Status:** approved for planning
**One line:** An LLM drives a browser once to learn a web task; that run compiles into a deterministic Playwright program that replays forever at zero LLM cost, and when the page drifts, one cheap call repairs the single step that broke.

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
| `understudy drift` | $0 | Runs every flow with healing **off**; reports what the web broke |

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
          "nearText": ["Invoices", "August 2026"],
          "depth": 4
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

A step stores a **semantic anchor**, not just a selector. The anchor — role, accessible name, nearby text, structural depth — is captured at learn time and is what survives a redesign.

This is what turns healing from *"re-run the agent and hope"* into a narrow, single-shot, verifiable question: *given this anchor, which element on the current page is it?* Narrow questions are cheap questions. The entire cost model of the project rests on this field.

### Step types

`goto` · `click` · `fill` · `select` · `waitFor` · `extract` · `assert`

Deliberately small. Anything not expressible in these seven is a signal the flow should be split, not that the vocabulary should grow.

## 5. Healing

On step failure (selector miss, timeout, or failed postcondition):

1. Try `fallbacks` in order — free, no LLM.
2. Capture a compact snapshot of the page (§7).
3. **One** LLM call: anchor + snapshot → new selector. Claude Haiku 4.5, `effort: "low"`.
4. Retry the step.
5. **Verify the postcondition.** A heal that isn't verified is a guess.
6. On success: patch the spec, bump `version`, push the old selector to `history` with a timestamp and the replay URL of the run where it broke.
7. On a second failure: escalate to full agent mode for the remainder of the flow, then recompile.

Healing is verified, never trusted. `--no-heal` exists so CI detects drift instead of silently absorbing it — that is what `drift` uses.

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

## 11. Evidence

Every command prints wall time, LLM calls, tokens, and dollars. `benchmarks.json` is written by real runs and committed.

The README's headline numbers must be measured, not claimed. If the speedup is 6× rather than 10×, the README says 6×.

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
2. Upstream PR to `solari-sdk/solari-cookbook`: `examples/browser-self-healing-selector-ts`, ~70 lines in the cookbook's house style — one selector, break it, heal it.
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
