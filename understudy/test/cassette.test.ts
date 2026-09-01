import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cassetteClient } from "../src/cassette.js"
import type { LlmClient } from "../src/llm.js"

const inner = (value: unknown) => {
  const c = {
    calls: 0,
    async complete() {
      c.calls++
      return { value, model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0 }
    },
  }
  return c as unknown as LlmClient & { calls: number }
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

  it("distinguishes different prompts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cass-")), "c.json")
    const a = cassetteClient(inner({ idx: 1 }), { mode: "record", path })
    await a.complete({ prompt: "one", schema: {} })
    const b = cassetteClient(inner({ idx: 2 }), { mode: "record", path })
    await b.complete({ prompt: "two", schema: {} })

    const play = cassetteClient(inner({ idx: 999 }), { mode: "replay", path })
    expect((await play.complete<{ idx: number }>({ prompt: "one", schema: {} })).value.idx).toBe(1)
    expect((await play.complete<{ idx: number }>({ prompt: "two", schema: {} })).value.idx).toBe(2)
  })
})
