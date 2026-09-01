/**
 * The paid repair tier -- reached only after fallbacks and free anchor scoring
 * have both declined. Measured on the v2-redesign mutation (id, label and name
 * attribute all changed at once), free scoring ranks the right element first
 * but at 0.628, below its 0.80 accept threshold. That is this module's job.
 *
 * One call, one step, no conversation.
 */
import type { Healer } from "./backends/types.js"
import type { LlmClient } from "./llm.js"
import type { SnapshotNode } from "./observe.js"

/** Below this the healer declines. A low-confidence repair is a guess. */
export const CONFIDENCE_FLOOR = 0.5

const SCHEMA = {
  type: "object",
  properties: {
    idx: { type: "integer", description: "idx of the element that is the same affordance" },
    confidence: { type: "number", description: "0 to 1" },
  },
  required: ["idx", "confidence"],
  additionalProperties: false,
}

const SYSTEM =
  "You match UI elements across versions of a web page. " +
  "You are given one element's semantic description from an earlier version, " +
  "and the elements present now. Identify which current element is the same " +
  "affordance. Answer with its idx and your confidence."

/**
 * The model sees only idx, role, name, attrs and nearby text -- never raw HTML
 * and never a selector. Because it answers with an index, it cannot invent a
 * selector that does not exist on the page.
 */
function describe(node: SnapshotNode) {
  return {
    idx: node.idx,
    role: node.role,
    name: node.name,
    attrs: node.attrs,
    nearText: node.nearText,
  }
}

export function llmHealer(
  llm: LlmClient,
  /** Called with the provider's error when the chain is exhausted. Without
   *  this a credentials failure looks identical to "no matching element". */
  onError?: (err: Error) => void,
): Healer {
  return {
    async heal({ anchor, snapshot }) {
      const prompt = [
        "The step targeted this element:",
        JSON.stringify(anchor, null, 2),
        "",
        "The page has changed. These elements are present now:",
        JSON.stringify(snapshot.nodes.map(describe), null, 2),
        "",
        "Which idx is the same affordance as the original?",
      ].join("\n")

      let res
      try {
        res = await llm.complete<{ idx: number; confidence: number }>({
          system: SYSTEM,
          prompt,
          schema: SCHEMA,
        })
      } catch (err) {
        // The runtime's contract is that a failed heal fails the step loudly.
        // Propagating here would abort the run before it can report which
        // step broke and why -- but the reason must not be silently discarded.
        onError?.(err as Error)
        return null
      }

      const { idx, confidence } = res.value
      if (typeof confidence !== "number" || confidence < CONFIDENCE_FLOOR) return null

      const picked = snapshot.nodes.find((n) => n.idx === idx)
      if (!picked) return null

      return {
        selector: picked.selector,
        costUsd: res.costUsd,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        ms: res.ms,
      }
    },
  }
}
