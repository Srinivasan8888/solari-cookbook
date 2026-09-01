/**
 * Record/replay around any LlmClient.
 *
 * The first real run of a flow costs money (or, on the free tier, patience);
 * every run after it replays from disk, free and deterministic. This is why
 * the whole test suite runs offline with no API key -- and why iterating on
 * compile/heal logic costs nothing once the interaction is captured.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { LlmClient, LlmRequest, LlmResponse } from "./llm.js"

export type CassetteMode = "record" | "replay" | "off"

export type CassetteOptions = {
  mode: CassetteMode
  path: string
}

type Entry = LlmResponse<unknown> & { prompt: string }
type Tape = Record<string, Entry>

function keyFor(req: LlmRequest): string {
  const canonical = JSON.stringify({
    system: req.system ?? null,
    prompt: req.prompt,
    schema: req.schema,
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32)
}

function readTape(path: string): Tape {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8")) as Tape
}

function writeTape(path: string, tape: Tape): void {
  mkdirSync(dirname(path), { recursive: true })
  // Pretty-printed so a recorded interaction is reviewable in a diff.
  writeFileSync(path, JSON.stringify(tape, null, 2) + "\n", "utf8")
}

export function cassetteClient(inner: LlmClient, opts: CassetteOptions): LlmClient {
  if (opts.mode === "off") return inner

  return {
    async complete<T>(req: LlmRequest): Promise<LlmResponse<T>> {
      const key = keyFor(req)
      const tape = readTape(opts.path)
      const hit = tape[key]

      if (hit) {
        const { prompt: _prompt, ...response } = hit
        return response as LlmResponse<T>
      }

      if (opts.mode === "replay") {
        // Never fall through to the network on a miss. A silent fallthrough
        // would spend money in CI and make the suite non-deterministic --
        // exactly the two things cassettes exist to prevent.
        throw new Error(
          `cassette miss: ${key.slice(0, 8)} for prompt "${req.prompt.slice(0, 60)}..."\n` +
            `  re-record with UNDERSTUDY_CASSETTE=record`,
        )
      }

      const fresh = await inner.complete<T>(req)
      tape[key] = { ...fresh, prompt: req.prompt.slice(0, 200) }
      writeTape(opts.path, tape)
      return fresh
    },
  }
}
