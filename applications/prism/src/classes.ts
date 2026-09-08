/**
 * The user classes to check, and what each must and must not see.
 *
 * Expectations are stated as testids that must be present or absent on the
 * rendered page. That is deliberate: a check that asserts "the profile was
 * attached" proves nothing about what the user actually got. Prism only ever
 * asserts things read back off a live page.
 */
export type UserClass = {
  name: string
  /** Cookies that define this identity. In production these come from a real
   *  login performed once in Solari's console; here they are seeded so the
   *  demo reproduces with no accounts. */
  cookies: { name: string; value: string }[]
  mustSee: string[]
  mustNotSee: string[]
  /** Why this class exists, printed in the report so a failure explains itself. */
  because: string
}

export const CLASSES: UserClass[] = [
  {
    name: "anon",
    cookies: [{ name: "tier", value: "anon" }],
    mustSee: ["heading", "signin", "consent-banner"],
    mustNotSee: ["export", "admin"],
    because: "a signed-out visitor must be offered sign-in and nothing paid",
  },
  {
    name: "free",
    cookies: [{ name: "tier", value: "free" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "quota"],
    mustNotSee: ["export", "admin"],
    because: "a free account must not reach paid-only export -- this is revenue leak",
  },
  {
    name: "paid",
    cookies: [{ name: "tier", value: "paid" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "export", "quota"],
    mustNotSee: ["admin", "signin"],
    because: "a paying account must get what it pays for, and no admin surface",
  },
  {
    name: "admin",
    cookies: [{ name: "tier", value: "admin" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "export", "admin"],
    mustNotSee: ["signin"],
    because: "an admin gets everything, but must still not look signed out",
  },
  {
    name: "eu-consent-rejected",
    cookies: [{ name: "tier", value: "free" }, { name: "consent", value: "rejected" }],
    mustSee: ["heading"],
    mustNotSee: ["tracker"],
    because: "a visitor who refused consent must not have trackers loaded -- this is a compliance breach",
  },
  {
    name: "eu-consent-accepted",
    cookies: [{ name: "tier", value: "free" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "tracker"],
    mustNotSee: ["consent-banner"],
    because: "a visitor who accepted should get the tracker and stop being asked",
  },
]
