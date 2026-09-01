export type Telemetry = {
  llmCalls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Replay and heal are reported separately; averaging them hides the point. */
  replayMs: number
  healMs: number
}

export function emptyTelemetry(): Telemetry {
  return { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, replayMs: 0, healMs: 0 }
}

export function formatTelemetry(t: Telemetry): string {
  return [
    `replay ${t.replayMs}ms`,
    `heal ${t.healMs}ms`,
    `llmCalls ${t.llmCalls}`,
    `tokens ${t.inputTokens}in/${t.outputTokens}out`,
    `cost $${t.costUsd.toFixed(4)}`,
  ].join("  ")
}
