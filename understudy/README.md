# Understudy

**A compiler for web tasks. The LLM is the compiler, not the runtime.**

An LLM drives a browser once to learn a task. That run compiles into a
deterministic Playwright program which replays forever at zero LLM cost. When
the page drifts, one cheap call repairs the single step that broke.

```
goal + site   ──▶  compiler   ──▶  flow.json   ──▶  runtime    ──▶  result
  (source)          (LLM, once)     (artifact)      (deterministic,
                                                     zero LLM)
                         ▲                               │
                         └──── incremental recompile ◀────┘
                              (one step, on drift)
```

## The numbers

Measured, not claimed. `npm run bench` regenerates every figure below into
[`benchmarks.json`](benchmarks.json).

```
100 runs       0 LLM calls   $0.0000   p50 72ms   p95 81ms
site change     1 LLM call    $0.0000   ~5-7s, once
100 runs       0 LLM calls   $0.0000   p50 71ms   p95 85ms
```

0 failures in 100 runs before the change, 0 in 100 after. The zero-LLM claim is
enforced by a test, not a promise: `runtime.ts` has no import path to an LLM
client, and `isolation.test.ts` walks the graph to prove it.

## The drift corpus

Ten mutations, 5 trials each. Every one breaks the flow's primary selector,
so each genuinely exercises the repair ladder — what differs is how much of the
anchor survives.

| class | what changed | predicted | repaired by | healed | tokens/call | latency |
|---|---|---|---|---|---|---|
| `id-rename` | id renamed | fallback | **fallback** | 5/5 | — | — |
| `class-churn` | id removed, generated classes | fallback | **fallback** | 5/5 | — | — |
| `label-change` | id + name changed, new text | llm | **llm** | 5/5 | 701/603 | 7357ms |
| `i18n` | id + name changed, French text | llm | **llm** | 5/5 | 710/422 | 4692ms |
| `reparent` | id + name changed, moved into a dropdown | llm ⚠️ | **fallback** | 5/5 | — | — |
| `reorder` | id + name changed, siblings swapped | anchor ⚠️ | **fallback** | 5/5 | — | — |
| `role-change` | id + name changed, button becomes an anchor | llm ⚠️ | **fallback** | 5/5 | — | — |
| `icon-only` | id + name changed, text replaced by an icon | llm | **llm** | 5/5 | 698/453 | 6245ms |
| `shadow-dom` | controls wrapped in a shadow root | fail ⚠️ | **fallback** | 5/5 | — | — |
| `ambiguous` | id + name changed, near-identical decoy added | fail | **fail** | 0/5 | — | — |

**45/50 repaired (90%)** for **$0.0000** — 6 classes free, 3 needing a model, 1 failing.

### What I got wrong

I wrote predictions before running it. **4 of 10 were wrong**, and the corrections
are more interesting than the hits:

- **`reparent`, `reorder`, `role-change` repaired for free.** I predicted all
  three needed a model. A `text=` fallback survives structural change far
  better than I expected — moving a button into a dropdown, swapping sibling
  order, even changing `<button>` to `<a role="button">` leaves the visible
  text intact, and that is enough.
- **`shadow-dom` did not fail.** Playwright's selectors pierce open shadow
  roots, so the runtime found the element anyway. What shadow DOM *does* break
  is `observe()` — `querySelectorAll` cannot pierce, so the element is
  invisible to anchor scoring and to the model. It survives here only because a
  cheaper rung caught it first.
- **`ambiguous` failed, as predicted, and should.** Two identical "Load
  invoices" buttons: the ladder picks the decoy, the postcondition rejects it,
  the run fails loudly. That is the correct outcome. A repair that cannot be
  verified is a guess, and this project would rather stop than guess.

The failure row is the point. A table where everything scores 100% reads as a
table that was never really run.

## How repair works

Three rungs, cheapest first. Nothing is accepted until the step's
postcondition confirms it.

1. **Fallbacks** — free. Alternative selectors the compiler generated.
2. **Anchor scoring** — free. Each step stores a four-layer semantic anchor
   (role+name, attributes, nearby text and landmarks, structural position), and
   candidates on the current page are scored against it. Accepted only when
   confident *and* unambiguous.
3. **A model** — one call, one step. Sees roles, names and nearby text, never
   raw HTML and never a selector. It answers with an *index*, so it cannot
   invent a selector that is not on the page.

A second failure **stops and reports**. Escalation to a full agent run is
opt-in behind `--escalate`, because a failure is the worst moment to start
spending without a ceiling.

## Watch it

```bash
npm run demo             # ~45s, the whole arc
npm run demo -- --headed # watch the browser drive itself
```

It works and costs nothing → the site ships a redesign → it fails loudly →
one model call repairs the one step that broke, verified before acceptance →
it costs nothing again.

## Quickstart

```bash
cd understudy && npm install && npx playwright install chromium

npx tsx demo-site/serve.ts v1 &                       # the demo portal
npx tsx src/cli.ts run invoice-export --input month=2026-08
# ok  replay 72ms  heal 0ms  llmCalls 0  tokens 0in/0out  cost $0.0000
```

Learning a new flow needs an [OpenRouter](https://openrouter.ai) key in
`understudy/.env` — the models used here are all free tier.

```bash
npx tsx src/cli.ts learn "export invoices for a month" --url http://localhost:8787
npx tsx src/cli.ts run <flow> --input month=2026-08 --heal
npx tsx src/cli.ts diff <flow>       # every automatic repair, auditable
npx tsx src/cli.ts drift             # CI check; cannot spend money
npx tsx src/cli.ts serve             # POST /flows/:name
```

## Running on Solari

Same artifact, same runtime — only where Chromium runs changes.

```bash
export SOLARI_API_KEY=slr_live_...
export SOLARI_STEALTH=1 SOLARI_PROXY=us
npx tsx src/cli.ts run invoice-export --backend solari --input month=2026-08
```

What the cloud adds is what a laptop structurally cannot: a server-side
**profile** so daily runs start already logged in, **residential egress** for
targets that block datacenter IPs, and a **DOM-level recording** of every run.

**On credentials.** Solari records input values by default, passwords included.
Understudy never types one: you populate a profile once in the console's live
browser editor (which handles 2FA and captcha with a human) and flows attach
`profileId`. The replay cannot contain a secret because a secret was never
typed.

## What this does not do

- **No desktop support.** There is no honest role for one here; adding it to
  touch a third product would be decoration.
- **`observe()` cannot pierce shadow DOM.** Real limitation, measured above.
- **Ambiguous duplicates defeat it.** Also measured above.
- **It does not improvise at run time.** It executes learned flows. That is the
  entire point.
- **The Solari backend is written against the published SDK types but has not
  been run against a live account.** Said plainly rather than implied.

## Cost

Building and benchmarking this cost **$0.00** in model spend. Every model used is
on OpenRouter's free tier, and cassettes in `fixtures/cassettes/` replay every
recorded interaction, so `npm test` runs offline with no API key at all.

## Reproducing

```bash
npm test        # 57 tests, no credentials required
npm run bench   # regenerates benchmarks.json
```

MIT.
