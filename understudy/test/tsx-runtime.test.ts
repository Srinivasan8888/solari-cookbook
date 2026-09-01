import { describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

describe("tsx entry point", () => {
  // Vitest and tsx use different esbuild settings. tsx injects a `__name`
  // helper into nested functions, which dies once page.evaluate serializes
  // the callback into the browser. The unit tests cannot see this, so the
  // only honest guard is to actually run the code the way users will.
  it("runs observe under tsx without a __name ReferenceError", async () => {
    const { stdout } = await run(
      "npx",
      ["tsx", join("test", "fixtures", "tsx-observe.ts")],
      { cwd: pkgRoot, timeout: 90_000 },
    )
    expect(JSON.parse(stdout.trim()).nodes).toBeGreaterThan(0)
  }, 120_000)
})
