/**
 * Solari cloud browsers, one server-side profile per user class.
 *
 * Three traps, all of them why the profiles example has been fixed twice:
 *   1. `profileId` does NOT seed the browser. The state arrives on
 *      `session.storageState` and must be handed to `newContext`; a page from
 *      `browser.newPage()` starts anonymous.
 *   2. State is discarded on release unless `profiles.save()` is called.
 *   3. A context you build yourself does not inherit the pool's timezone pin,
 *      so `timezoneId` has to be forwarded or Intl disagrees with the egress IP.
 */
import { Solari, SolariError } from "@solarisdk/browser"
import { EXTRACT, type Backend, type PageProbe } from "./backend.js"

export type SolariOpts = { apiKey: string; profilePrefix?: string }

export async function solariBackend(opts: SolariOpts): Promise<Backend> {
  const solari = new Solari({ apiKey: opts.apiKey })
  const prefix = opts.profilePrefix ?? "prism"

  return {
    name: "solari",
    async probe(url, cookies, label): Promise<PageProbe> {
      const name = `${prefix}-${label}`
      const existing = (await solari.profiles.list()).find((p) => p.name === name)
      const profile = existing ?? (await solari.profiles.create({ name }))

      // Seeding is DEMO-ONLY. In production a human populates the profile once
      // in Solari's console live browser -- 2FA and captcha included -- and CI
      // never sees a credential. Seeding here keeps the demo reproducible for
      // someone with no account on the target app.
      const origin = new URL(url).origin
      await solari.profiles.save(profile.id, {
        cookies: cookies.map((c) => ({ ...c, domain: new URL(origin).hostname, path: "/" })),
      })

      const browser = await solari.launch({ profileId: profile.id })
      try {
        const storageState = browser.session.storageState as
          | NonNullable<Parameters<typeof browser.newContext>[0]>["storageState"]
          | undefined
        const ctx = await browser.newContext({ storageState, timezoneId: browser.proxy?.timezoneId })
        const page = await ctx.newPage()
        await page.goto(url, { waitUntil: "load" })
        return { testids: await page.evaluate(EXTRACT), title: await page.title(), url: page.url() }
      } finally {
        await browser.close()
      }
    },
    async close() { await solari.close() },
  }
}

/** True when the API refused because the account is at its concurrency cap. */
export function isConcurrencyLimit(err: unknown): boolean {
  return err instanceof SolariError && err.status === 429
}
