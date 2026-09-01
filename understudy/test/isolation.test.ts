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

    // It must actually be walking the graph, or this test proves nothing.
    expect(reached.length).toBeGreaterThan(3)

    const offenders = reached.filter((f) => FORBIDDEN.some((bad) => f.endsWith(bad)))
    expect(offenders).toEqual([])

    for (const file of reached) {
      expect(readFileSync(file, "utf8")).not.toContain("@anthropic-ai/sdk")
    }
  })
})
