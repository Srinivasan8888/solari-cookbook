/**
 * Solari cloud browser backend.
 *
 * Same flow artifact, same runtime -- the only thing that changes is where
 * Chromium runs. What the cloud adds is the part a laptop structurally cannot:
 * a server-side profile so daily runs start logged in, residential egress for
 * targets that block datacenter IPs, and a DOM-level recording of every run.
 *
 * Credentials note: Solari records input values by default, passwords
 * included. Understudy never types one -- you populate a profile once in the
 * console's live browser editor (which handles 2FA and captcha with a human)
 * and flows attach `profileId`. The replay cannot contain a secret because a
 * secret was never typed.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright"
import type { Backend, BackendSession } from "./types.js"

export type SolariBackendOptions = {
  apiKey: string
  /** Fingerprint patches plus a headful browser. Required for proxy/captcha. */
  stealth?: boolean
  /** "us", "smart", { country: "gb" }, ... Implies stealth. */
  proxy?: string
  /** DOM-level rrweb capture. On by default: it is the audit trail. */
  recording?: boolean
}

export function solariBackend(opts: SolariBackendOptions): Backend {
  const recording = opts.recording ?? true

  return {
    name: "solari",
    async open({ profile }): Promise<BackendSession> {
      const client = new Solari({ apiKey: opts.apiKey })

      // `proxy` and `captcha` both REQUIRE stealth -- a proxied request from an
      // obviously-automated browser is the pairing that gets blocked.
      const stealth = opts.stealth === true || opts.proxy !== undefined

      const browser = await client.launch({
        recording,
        ...(profile ? { profileId: profile } : {}),
        ...(stealth ? { stealth: true } : {}),
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
      })

      const sessionId = browser.id
      let released = false

      return {
        // BrowserSession.newPage() returns patchright-core's Page. It is the
        // same Playwright surface this project uses (goto/locator/evaluate);
        // the packages differ only nominally.
        page: (await browser.newPage()) as unknown as Page,

        sessionId,

        async replayUrl(): Promise<string | null> {
          // Deliberately null while the session is live. A presigned replay URL
          // does not exist until the session is released, and releasing here
          // would kill the run that is asking. The session id is recorded in
          // history instead; resolve it afterwards with getReplayUrl.
          return null
        },

        async close(): Promise<void> {
          if (!released) {
            // Releases the session as well as closing the browser.
            await browser.close()
            released = true
          }
          if (recording) {
            try {
              await client.sessions.releaseAndWait(sessionId)
              const { url } = await client.sessions.getReplayUrl(sessionId)
              console.error(`replay: ${url}`)
            } catch {
              // The upload is async after release; a miss here is not fatal.
            }
          }
          // REQUIRED. The client keeps a loopback proxy open for the
          // connection-retry path, and that handle keeps the event loop alive:
          // skip this and the process prints its output and then hangs forever.
          await client.close()
        },
      }
    },
  }
}
