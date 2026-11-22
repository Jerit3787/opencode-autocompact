import { describe, expect, it } from "vitest"
import { formatStatus } from "./status"

const base = {
  threshold: 500_000,
  source: "chat" as const,
  tokens: 321_136,
  modelWindow: 1_000_000,
  enabled: true,
  pending: false,
  armed: true,
  configThreshold: 500_000,
  global: 500_000,
  project: null,
  session: 500_000,
}

describe("formatStatus", () => {
  it("reports the effective threshold and source", () => {
    const text = formatStatus(base)
    expect(text).toContain("Autocompact threshold: 500,000 tokens (chat)")
    expect(text).toContain("Current context: 321,136 tokens (64.2%)")
    expect(text).toContain("Auto-compaction is armed.")
    expect(text).toContain("Model context window: 1,000,000 tokens.")
  })

  it("warns when the threshold is at or above the model window", () => {
    const text = formatStatus({ ...base, threshold: 1_000_000, session: 1_000_000 })
    expect(text).toContain("will never be reached")
  })

  it("reports pending, paused, failed, and disabled states", () => {
    expect(formatStatus({ ...base, pending: true })).toContain("pending")
    expect(formatStatus({ ...base, tokens: 600_000, armed: false })).toContain("paused")
    expect(formatStatus({ ...base, tokens: 600_000, armed: true })).toContain("armed")
    expect(formatStatus({ ...base, failedAt: 1 })).toContain("failed")
    expect(formatStatus({ ...base, enabled: false })).toContain("disabled")
  })

  it("shows the project and global fallbacks when overridden", () => {
    const text = formatStatus({
      ...base,
      source: "chat",
      global: 600_000,
      project: 700_000,
      session: 800_000,
      threshold: 800_000,
    })
    expect(text).toContain("Global default: 600,000 tokens.")
    expect(text).toContain("Project override: 700,000 tokens.")
  })
})
