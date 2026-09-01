import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { serveVariant, type DemoServer } from "../demo-site/serve.js"

const run = promisify(execFile)
const ROOT = resolve(import.meta.dirname, "..")

let server: DemoServer
// The committed flow points at 8787; serve there so the artifact runs as shipped.
beforeAll(async () => { server = await serveVariant("v1", 8787) })
afterAll(async () => { await server.close() })

// Shelling out to tsx is deliberate. Vitest and tsx use different esbuild
// settings, and a real bug (the __name crash) passed every unit test while
// the tsx entry point was broken. The CLI must be exercised as users run it.
async function cli(args: string[]) {
  // Explicitly empty, not deleted: the CLI loads .env, and an absent key would
  // simply be repopulated from the file. Empty means "no credentials" and the
  // real environment takes precedence over the dotfile.
  const env = { ...process.env, OPENROUTER_API_KEY: "" }
  try {
    const { stdout, stderr } = await run("npx", ["tsx", join("src", "cli.ts"), ...args], {
      cwd: ROOT, env, timeout: 90_000,
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

describe("cli", () => {
  it("runs the committed flow with zero LLM calls and exits 0", async () => {
    const { code, stdout, stderr } = await cli(["run", "invoice-export", "--input", "month=2026-08"])
    expect(code).toBe(0)
    expect(stderr).toContain("llmCalls 0")
    expect(stderr).toContain("cost $0.0000")
    expect(JSON.parse(stdout).status).toContain("3 results")
  }, 120_000)

  it("exits non-zero when a flow fails, so cron and CI can see it", async () => {
    const { code, stderr } = await cli(["run", "invoice-export", "--input", "nothing=x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("failed at")
  }, 120_000)

  it("refuses --heal without a key instead of failing obscurely", async () => {
    const { code, stderr } = await cli(["run", "invoice-export", "--input", "month=2026-08", "--heal"])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/OPENROUTER_API_KEY is not set/)
  }, 120_000)

  it("reports repair history", async () => {
    const { code, stdout } = await cli(["diff", "invoice-export"])
    expect(code).toBe(0)
    expect(stdout).toContain("invoice-export v")
  }, 120_000)
})
