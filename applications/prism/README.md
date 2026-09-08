# Prism

One URL, every user class at once.

A web app shows different things to different people: signed out, free, paid,
admin, consented, not consented. Getting that wrong is expensive in two
directions — a free account that can reach a paid feature is revenue walking out
the door, and a visitor who refused cookies but still loads your tracker is a
regulatory problem. Almost nobody tests it, because testing it means holding
several sets of real credentials and driving several authenticated browsers at
the same time.

Prism renders one URL as every user class simultaneously and asserts what each
one **actually saw**.

## Watch it

Needs no credentials. The demo site ships two deliberate bugs.

```bash
npm install && npx playwright install chromium
npm run demo
```

```
| user class | verdict | what was wrong | time |
|---|---|---|---|
| anon | pass | as expected | 350ms |
| free | FAIL | LEAKED export | 351ms |
| paid | pass | as expected | 345ms |
| admin | pass | as expected | 351ms |
| eu-consent-rejected | FAIL | LEAKED tracker | 347ms |
| eu-consent-accepted | pass | as expected | 350ms |
```

`free` reaching the Pro export button is the revenue leak. `eu-consent-rejected`
still loading the tracker is the compliance breach. Both are planted, both are
found, and the run exits 0 because finding them is the point. `npm run demo --
--fix` serves the corrected app and all six pass.

## How it decides

Every verdict comes from `data-testid` attributes read off a live page after a
real HTTP navigation. Nothing asserts that a profile attached or that a cookie
was set — those can all be true while the user still sees the wrong page. Each
class declares what it must see and must not see, and why:

```ts
{
  name: "free",
  mustSee: ["heading", "quota"],
  mustNotSee: ["export", "admin"],
  because: "a free account must not reach paid-only export -- this is revenue leak",
}
```

The `because` line is printed on failure, so a red run explains itself without
anyone reading the source.

## The Solari part

The honest claim is not "many browsers at once" — a laptop can run twenty
Playwright contexts with twenty `storageState` objects. It is **where the
session lives**.

A Solari profile is server-side. A human populates it once in the console's live
browser, clearing 2FA and a captcha by hand. Every run after that needs only
`SOLARI_API_KEY`. Local Playwright cannot do this: the credential has to exist
somewhere you control — a secret store, a committed cookie jar, a file on the
runner. Prism's `check` phase never holds one.

The demo seeds profile state directly so it reproduces with no accounts. That
shortcut is demo-only and is the one place credentials appear.

## Running on Solari

```bash
export SOLARI_API_KEY=slr_live_...
npm run check -- --backend solari
```

A cloud browser cannot reach `127.0.0.1`, so with no `--url` Prism serves the
demo site from a Solari **sandbox** and points the browsers at its public
preview URL — sandbox and browsers on one key. Point `--url` at a real
deployment to check your own app.

Verified live on 2026-09-08 (Starter): six cloud browsers, six server-side
profiles, sandbox-hosted site, guest Node v18.20.4. Same two failures and same
four passes as the local run, ~5.2s per class. The runs are committed in
[`proof/`](proof) — `local.json` and `solari.json`, generated with `--proof`.

Two traps that cost time, in case they save you some:

- `previewUrl()` returns a URL whose credential is a `pt_token` **query
  parameter**. Fetching the same origin without it is `401 invalid preview
  token`, and the token is rejected as an `Authorization` header, an
  `x-solari-token` header, or a cookie. Rebuilding the URL — even
  `new URL("/", url)` — locks you out.
- The base sandbox image runs Node 18 with no build step, so the site uploaded
  to it is the same plain `demo-site/site.js` the local run uses. One file, so
  the cloud cannot quietly serve a different app than the one you checked.

## The fleet

Starter documents 20 concurrent browsers. Measured on 2026-09-08, the API
accepts 18 and refuses the 19th with
`429 {"code":"ConcurrencyLimitExceeded","cap":20}` — the error states a cap it
does not honour. A released slot is reusable in about 300ms.

So `runFleet` starts below the published number and **shrinks on backpressure**
rather than trusting it. Two properties have to hold, and an earlier hand-rolled
scheduler broke both: never more than the current limit running (a retry that
re-enters without re-acquiring goes straight back over the cap that just
rejected it), and never resolve while a probe is in flight (resolving early lets
a retry open a cloud session *after* the backend closed — leaking the billable
slot the pool exists to protect). A semaphore plus `Promise.all` gives both by
construction.

## What this does not do

- **The demo site is ours.** This proves the mechanism, not that a real paywall
  was defeated. Pointing `--url` at a real app is the one config change.
- **No anti-bot claim.** Stealth returns
  `503 {"error":"No stealth pool available","fleet":"empty"}`, and proxy
  requires stealth, so neither was exercised.
- **No replay evidence.** `recording: true` produced no replay on `kind: "fast"`
  in 29 sessions, so Prism's evidence is its own `proof/` files, not a Solari
  replay.
- **The tracker check is DOM presence,** not a network assertion. It catches a
  tracker tag in the markup; a tracker injected later by script would need a
  request-level check.
- **~18 concurrent, not 20.**

## Reproducing

```bash
npm install
npx playwright install chromium
npm test                    # 17 tests, no credentials
npm run demo                # the two planted bugs, exit 0
npm run demo -- --fix       # all six pass
```

MIT.
