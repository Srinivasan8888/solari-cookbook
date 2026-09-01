import type { Anchor } from "./spec.js"
import type { Snapshot, SnapshotNode } from "./observe.js"

/** Accept a free repair only above this score... */
export const ACCEPT_SCORE = 0.8
/** ...and only if it beats the runner-up by this much. */
export const ACCEPT_MARGIN = 0.15

const WEIGHTS = {
  role: 0.2,
  name: 0.25,
  attrs: 0.2,
  nearText: 0.15,
  landmarks: 0.05,
  sibling: 0.1,
  fingerprint: 0.05,
} as const

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const A = new Set(a)
  const B = new Set(b)
  const inter = [...A].filter((x) => B.has(x)).length
  const union = new Set([...A, ...B]).size
  return union === 0 ? 0 : inter / union
}

/**
 * Four independent layers, so no single page change can zero every term.
 * A rename kills `name` but not `attrs` or `sibling`; a redesign kills
 * `sibling` but not `role` or `nearText`.
 */
export function scoreCandidate(anchor: Anchor, node: SnapshotNode): number {
  const role = anchor.role === node.role ? 1 : 0
  const name = anchor.nameNormalized === node.nameNormalized ? 1 : 0

  const attrKeys = ["testId", "name", "type"] as const
  const present = attrKeys.filter((k) => anchor.attrs[k] !== null)
  const attrs =
    present.length === 0
      ? 0.5
      : present.filter((k) => anchor.attrs[k] === node.attrs[k]).length / present.length

  const nearText = jaccard(anchor.nearText, node.nearText)
  const landmarks = jaccard(anchor.landmarks, node.landmarks)
  const sibling =
    (anchor.siblingRole === node.siblingRole ? 0.5 : 0) +
    (anchor.siblingOrdinal === node.siblingOrdinal ? 0.5 : 0)
  const fp = jaccard(anchor.textFingerprint, node.textFingerprint)

  return (
    role * WEIGHTS.role +
    name * WEIGHTS.name +
    attrs * WEIGHTS.attrs +
    nearText * WEIGHTS.nearText +
    landmarks * WEIGHTS.landmarks +
    sibling * WEIGHTS.sibling +
    fp * WEIGHTS.fingerprint
  )
}

export type Ranking = {
  ranked: { node: SnapshotNode; score: number }[]
  /** Non-null only when confident AND unambiguous. */
  accepted: SnapshotNode | null
}

export function rankCandidates(anchor: Anchor, snapshot: Snapshot): Ranking {
  const ranked = snapshot.nodes
    .map((node) => ({ node, score: scoreCandidate(anchor, node) }))
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]
  const second = ranked[1]
  const confident = best !== undefined && best.score >= ACCEPT_SCORE
  const unambiguous = second === undefined || best!.score - second.score >= ACCEPT_MARGIN

  return { ranked, accepted: confident && unambiguous ? best!.node : null }
}
