# Understudy — Plan 3: The Proof and the Ship

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce the benchmark that proves the thesis, and ship the result.

**Architecture:** A ten-class drift corpus generated from `v1` by declarative mutations, a `bench` command that measures B1/B2/B3, a `drift` command that is structurally incapable of spending money, and a README whose headline numbers are copied out of a committed `benchmarks.json`.

**Cost: ~$0.03.** Cassettes collapse 50 trials into roughly one real call per mutation class.

---

## Tasks

1. **Handler binding refactor** — `v1` binds handlers via `data-role`, not `id`, so a mutation can rename an id without breaking the page it is mutating. `data-role` is deliberately not a selector `observe` emits, so it never becomes a free fallback.
2. **Mutation corpus** — `demo-site/mutations.ts`: ten declarative mutations applied to `v1`, written out as committed variant files so a reviewer can read the diffs.
3. **`bench`** — B1 (100 runs, assert 0 LLM calls), B2 (each class × 5 trials, record tier/tokens/cost/latency), B3 (100 runs after a heal, assert back to 0). Writes `benchmarks.json`.
4. **`drift`** — every flow, healer `null`, non-zero exit on breakage. Plus a GitHub Action running it on a schedule.
5. **`serve`** — `POST /flows/:name`, typed JSON in and out.
6. **Solari backend** — implements `Backend` against `@solarisdk/browser`, adding `profileId`, `stealth`, `proxy`, `recording` and a shareable replay URL.
7. **README** — numbers copied from `benchmarks.json`, including the failures.
8. **Upstream example** — `examples/browser-self-healing-selector-ts`, ~70 lines in the cookbook's house style.

## The corpus

Every mutation breaks the primary selector, so each one actually exercises the ladder. What differs is how much of the anchor survives.

| # | Class | Change | Expected tier |
|---|---|---|---|
| 1 | `id-rename` | id renamed | fallback |
| 2 | `class-churn` | id removed, generated classes | fallback |
| 3 | `label-change` | id + name changed, new text | llm |
| 4 | `i18n` | id + name changed, French text | llm |
| 5 | `reparent` | id + name changed, moved into a dropdown | llm |
| 6 | `reorder` | id + name changed, siblings swapped | anchor/llm |
| 7 | `role-change` | id + name changed, `<button>` → `<a role=button>` | llm |
| 8 | `icon-only` | id + name changed, text → icon + aria-label | llm |
| 9 | `shadow-dom` | component wrapped in a shadow root | **expected FAIL** |
| 10 | `ambiguous` | id + name changed, near-identical decoy added | **expected FAIL** |

Classes 9 and 10 are expected to fail and their failures get published. A table
where everything scores 100% reads as a table that was never really run, and
knowing *which* drift defeats the anchor is the most useful thing this project
can tell anyone.

## Done when

- `npm run bench` regenerates `benchmarks.json` in one command, so a reviewer can reproduce the headline rather than trust it.
- README leads with measured numbers, failures included.
- `drift` exits non-zero on breakage and cannot spend money.
- `npm test` green with no credentials.
