import type { Page } from "playwright"
import type { Anchor } from "../spec.js"
import type { Snapshot } from "../observe.js"

export interface BackendSession {
  page: Page
  /** Solari returns a shareable replay link; local has none. */
  replayUrl(): Promise<string | null>
  close(): Promise<void>
}

export interface Backend {
  name: "local" | "solari"
  open(opts: { profile: string | null }): Promise<BackendSession>
}

/**
 * The paid repair tier. Declared here so runtime.ts can depend on the
 * interface without importing anything that can reach the network.
 * Implemented in Plan 2. Latency is measured by the runtime, not
 * self-reported.
 */
export interface Healer {
  heal(input: {
    anchor: Anchor
    snapshot: Snapshot
    failedSelector: string
  }): Promise<{ selector: string; costUsd: number } | null>
}
