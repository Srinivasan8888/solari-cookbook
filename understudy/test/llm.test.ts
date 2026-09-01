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
    await expect(client.complete(req)).rejects.toThrow(/m1[\s\S]*m2/)
  })

  it("reports zero cost for :free models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ idx: 0 }, "x:free"))
    const client = openRouterClient({ apiKey: "k", models: ["x:free"], fetchImpl: fetchImpl as never })
    expect((await client.complete(req)).costUsd).toBe(0)
  })
})
