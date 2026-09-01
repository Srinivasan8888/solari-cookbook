/**
 * Provider-agnostic JSON completion with a model fallback chain.
 *
 * The chain is not a nicety. Racing four free OpenRouter models on the real
 * heal task, one answered, two returned provider errors ("Service temporarily
 * overloaded"), and one was too weak to produce valid JSON. A single-model
 * healer fails randomly on this tier.
 *
 * Native tool-calling is deliberately not used: free models handle it
 * unreliably, and a strict JSON schema is both better supported and
 * deterministic to cassette.
 */

export type LlmRequest = {
  system?: string
  prompt: string
  schema: object
  maxTokens?: number
}

export type LlmResponse<T> = {
  value: T
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Wall time of the live call. Preserved through cassettes so a replayed
   *  benchmark reports what the call actually cost in seconds, not what it
   *  costs to read a file. */
  ms: number
}

export interface LlmClient {
  complete<T>(req: LlmRequest): Promise<LlmResponse<T>>
}

export type OpenRouterOptions = {
  apiKey: string
  models: string[]
  fetchImpl?: typeof fetch
  baseUrl?: string
}

/**
 * Every model this project currently uses is on OpenRouter's free tier, so
 * spend is genuinely zero. Paid pricing arrives with the Plan 3 benchmark;
 * until then, reporting a rate we have not computed would be worse than
 * reporting the truth, which is 0.
 */
function priceOf(_model: string): number {
  return 0
}

export function openRouterClient(opts: OpenRouterOptions): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1"

  return {
    async complete<T>(req: LlmRequest): Promise<LlmResponse<T>> {
      const failures: string[] = []
      const startedAll = Date.now()

      for (const model of opts.models) {
        try {
          const res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${opts.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                ...(req.system ? [{ role: "system", content: req.system }] : []),
                { role: "user", content: req.prompt },
              ],
              response_format: {
                type: "json_schema",
                json_schema: { name: "result", strict: true, schema: req.schema },
              },
              max_tokens: req.maxTokens ?? 2000,
            }),
          })

          if (!res.ok) {
            failures.push(`${model}: HTTP ${res.status}`)
            continue
          }

          const body = (await res.json()) as {
            model?: string
            error?: { message?: string }
            choices?: { message?: { content?: string } }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }

          if (body.error) {
            failures.push(`${model}: ${body.error.message ?? "provider error"}`)
            continue
          }

          const content = body.choices?.[0]?.message?.content
          if (!content) {
            failures.push(`${model}: empty completion`)
            continue
          }

          let value: T
          try {
            value = JSON.parse(content) as T
          } catch {
            failures.push(`${model}: unparseable JSON`)
            continue
          }

          const answered = body.model ?? model
          return {
            value,
            model: answered,
            inputTokens: body.usage?.prompt_tokens ?? 0,
            outputTokens: body.usage?.completion_tokens ?? 0,
            costUsd: priceOf(answered),
            ms: Date.now() - startedAll,
          }
        } catch (err) {
          failures.push(`${model}: ${(err as Error).message}`)
        }
      }

      // Name every model and its reason. A generic failure here is untraceable
      // at 3am, which is exactly when a nightly flow breaks.
      throw new Error(`all models failed:\n  ${failures.join("\n  ")}`)
    },
  }
}
