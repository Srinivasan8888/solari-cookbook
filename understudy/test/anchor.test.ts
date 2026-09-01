import { describe, expect, it } from "vitest"
import { rankCandidates, scoreCandidate, ACCEPT_SCORE, ACCEPT_MARGIN } from "../src/anchor.js"
import type { Anchor } from "../src/spec.js"
import type { Snapshot, SnapshotNode } from "../src/observe.js"

const anchor: Anchor = {
  role: "button",
  name: "Export CSV",
  nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices", "3 results"],
  landmarks: ["main", "section[Invoices]"],
  siblingOrdinal: 1,
  siblingRole: "button",
  textFingerprint: ["export", "csv", "invoices"],
}

const node = (over: Partial<SnapshotNode>): SnapshotNode => ({
  idx: 0,
  role: "button",
  name: "Export CSV",
  nameNormalized: "export csv",
  attrs: { testId: null, name: "export", type: "submit" },
  nearText: ["Invoices", "3 results"],
  landmarks: ["main", "section[Invoices]"],
  siblingOrdinal: 1,
  siblingRole: "button",
  textFingerprint: ["export", "csv", "invoices"],
  selector: "#export-btn",
  ...over,
})

describe("scoreCandidate", () => {
  it("scores an identical element at 1", () => {
    expect(scoreCandidate(anchor, node({}))).toBeCloseTo(1, 5)
  })

  it("still accepts after an id rename, since no scored field uses the id", () => {
    expect(scoreCandidate(anchor, node({ selector: "#btn-export" }))).toBeCloseTo(1, 5)
  })

  // The boundary between the free tier and the paid one. A relabelled button
  // keeps role, attrs, position and neighbours, so the anchor does not
  // collapse -- but visible text is the strongest single signal a human uses,
  // and losing it is exactly the case worth paying a model to adjudicate.
  // Repairing this for free would mean guessing; declining is the design.
  it("declines to repair a label change for free, escalating to the paid tier", () => {
    const renamed = node({
      name: "Download report",
      nameNormalized: "download report",
      textFingerprint: ["download", "report", "invoices"],
      selector: "#export-btn",
    })
    expect(scoreCandidate(anchor, renamed)).toBeLessThan(ACCEPT_SCORE)
  })

  it("still ranks a relabelled element far above an unrelated one", () => {
    const renamed = node({
      name: "Download report",
      nameNormalized: "download report",
      textFingerprint: ["download", "report", "invoices"],
    })
    const unrelated = node({
      role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null },
      nearText: [], landmarks: ["nav"], siblingOrdinal: 2, siblingRole: "link",
      textFingerprint: ["settings"],
    })
    expect(scoreCandidate(anchor, renamed)).toBeGreaterThan(
      scoreCandidate(anchor, unrelated) + 0.3,
    )
  })

  it("scores an unrelated element low", () => {
    const other = node({
      role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null },
      nearText: [], landmarks: ["nav"], siblingOrdinal: 2, siblingRole: "link",
      textFingerprint: ["settings"], selector: "#settings-tab",
    })
    expect(scoreCandidate(anchor, other)).toBeLessThan(0.4)
  })
})

describe("rankCandidates", () => {
  const snapshot = (nodes: SnapshotNode[]): Snapshot => ({ url: "http://x/", nodes })

  it("returns the best match first with an accept decision", () => {
    const best = node({ selector: "#btn-export" })
    const decoy = node({
      role: "link", name: "Settings", nameNormalized: "settings",
      attrs: { testId: null, name: null, type: null },
      nearText: [], landmarks: ["nav"], siblingOrdinal: 0, siblingRole: "link",
      textFingerprint: ["settings"], selector: "#settings-tab",
    })
    const ranked = rankCandidates(anchor, snapshot([decoy, best]))
    expect(ranked.accepted?.selector).toBe("#btn-export")
  })

  it("refuses to accept when two candidates are equally good", () => {
    const a = node({ selector: "#export-a" })
    const b = node({ selector: "#export-b" })
    const ranked = rankCandidates(anchor, snapshot([a, b]))
    expect(ranked.accepted).toBeNull()
    expect(ranked.ranked[0]!.score - ranked.ranked[1]!.score).toBeLessThan(ACCEPT_MARGIN)
  })
})
