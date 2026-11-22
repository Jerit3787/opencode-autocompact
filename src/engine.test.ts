import { describe, expect, it } from "vitest"
import {
  AutoCompactController,
  contextTokens,
  latestContextTokens,
  parseAutocompactCommand,
  parseCommandTokenCount,
  parseTokenCount,
  type TokenMessage,
} from "./engine"

describe("contextTokens", () => {
  it("sums every usage bucket", () => {
    expect(
      contextTokens({
        input: 1000,
        output: 200,
        reasoning: 50,
        cache: { read: 8000, write: 300 },
      }),
    ).toBe(9550)
  })

  it("tolerates missing and invalid buckets", () => {
    expect(contextTokens(undefined)).toBe(0)
    expect(contextTokens({})).toBe(0)
    expect(
      contextTokens({
        input: Number.NaN,
        output: -5,
        cache: { read: 12, write: Number.POSITIVE_INFINITY },
      }),
    ).toBe(12)
  })
})

describe("latestContextTokens", () => {
  const messages: TokenMessage[] = [
    { type: "user" },
    { type: "assistant", tokens: { input: 10, output: 2 } },
    { type: "user" },
    { type: "assistant", tokens: { input: 20, output: 3, cache: { read: 100 } } },
    { type: "assistant" },
    { type: "idle" },
  ]

  it("uses the newest assistant message that reports usage", () => {
    expect(latestContextTokens(messages)).toBe(123)
  })

  it("returns zero when no assistant usage exists", () => {
    expect(latestContextTokens([])).toBe(0)
    expect(latestContextTokens([{ type: "user" }])).toBe(0)
  })
})

describe("parseTokenCount", () => {
  it("accepts numbers and compact strings", () => {
    expect(parseTokenCount(500_000, 1)).toBe(500_000)
    expect(parseTokenCount("500000", 1)).toBe(500_000)
    expect(parseTokenCount("500k", 1)).toBe(500_000)
    expect(parseTokenCount("1.5M", 1)).toBe(1_500_000)
  })

  it("falls back for unusable values", () => {
    expect(parseTokenCount(undefined, 500_000)).toBe(500_000)
    expect(parseTokenCount(0, 500_000)).toBe(500_000)
    expect(parseTokenCount("a lot", 500_000)).toBe(500_000)
  })
})

describe("parseCommandTokenCount", () => {
  it("accepts token counts with k and M suffixes", () => {
    expect(parseCommandTokenCount("500k")).toBe(500_000)
    expect(parseCommandTokenCount("1M")).toBe(1_000_000)
    expect(parseCommandTokenCount("1.5m")).toBe(1_500_000)
    expect(parseCommandTokenCount("500000")).toBe(500_000)
  })

  it("treats a bare 100-1000 as thousands, like Claude Code", () => {
    expect(parseCommandTokenCount("300")).toBe(300_000)
    expect(parseCommandTokenCount("1000")).toBe(1_000_000)
    expect(parseCommandTokenCount("99")).toBe(99)
  })

  it("returns undefined for unusable values", () => {
    expect(parseCommandTokenCount("")).toBeUndefined()
    expect(parseCommandTokenCount("a lot")).toBeUndefined()
    expect(parseCommandTokenCount("500k tokens")).toBeUndefined()
  })
})

describe("parseAutocompactCommand", () => {
  it("defaults to status and recognizes control words", () => {
    expect(parseAutocompactCommand("")).toEqual({ action: "status" })
    expect(parseAutocompactCommand("status")).toEqual({ action: "status" })
    expect(parseAutocompactCommand("compact")).toEqual({ action: "compact" })
    expect(parseAutocompactCommand("auto")).toEqual({ action: "auto" })
    expect(parseAutocompactCommand("default")).toEqual({ action: "auto" })
  })

  it("treats other input as a threshold", () => {
    expect(parseAutocompactCommand("500k")).toEqual({ action: "set", argument: "500k" })
    expect(parseAutocompactCommand("  1M  ")).toEqual({ action: "set", argument: "1M" })
  })
})

describe("AutoCompactController", () => {
  it("triggers once at the threshold and then waits for the request", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 99, 0)).toBe(false)
    expect(controller.observe("ses_1", 100, 0)).toBe(true)
    // observe() disarms immediately, so a second observation cannot double-fire
    expect(controller.observe("ses_1", 101, 0)).toBe(false)
    controller.requested("ses_1")
    expect(controller.observe("ses_1", 102, 0)).toBe(false)
  })

  it("re-arms only after context drops below the threshold", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 120, 0)).toBe(true)
    controller.requested("ses_1")
    controller.compactionStarted("ses_1")
    controller.compactionEnded("ses_1")

    expect(controller.observe("ses_1", 110, 1)).toBe(false)
    expect(controller.observe("ses_1", 99, 2)).toBe(false)
    expect(controller.observe("ses_1", 100, 3)).toBe(true)
  })

  it("does not retrigger immediately when compaction leaves context above the threshold", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 120, 0)).toBe(true)
    controller.requested("ses_1")
    controller.compactionEnded("ses_1")
    // Context is still (or again) high: stay paused rather than looping.
    expect(controller.observe("ses_1", 130, 1)).toBe(false)
    expect(controller.observe("ses_1", 130, 60_000)).toBe(false)
  })

  it("retries a failed compaction after the backoff", () => {
    const controller = new AutoCompactController({ threshold: 100, retryAfterMs: 1_000 })
    expect(controller.observe("ses_1", 120, 0)).toBe(true)
    controller.requested("ses_1")
    controller.compactionFailed("ses_1", 0)

    expect(controller.observe("ses_1", 130, 999)).toBe(false)
    expect(controller.observe("ses_1", 130, 1_000)).toBe(true)
  })

  it("treats a built-in compaction as pending and re-arms from note()", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 120, 0)).toBe(true)
    controller.compactionStarted("ses_1")
    controller.compactionEnded("ses_1")
    controller.note("ses_1", 20)
    expect(controller.observe("ses_1", 100, 1)).toBe(true)
  })

  it("does nothing when disabled", () => {
    const controller = new AutoCompactController({ threshold: 100, enabled: false })
    expect(controller.observe("ses_1", 500, 0)).toBe(false)
    expect(controller.snapshot("ses_1").enabled).toBe(false)
  })

  it("applies a new threshold immediately and re-arms for it", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 100, 0)).toBe(true)

    controller.requested("ses_1")
    controller.compactionEnded("ses_1")
    expect(controller.observe("ses_1", 120, 1)).toBe(false)

    controller.setThreshold(150)
    expect(controller.threshold).toBe(150)
    expect(controller.observe("ses_1", 150, 2)).toBe(true)
  })

  it("uses a different threshold per session", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    controller.setSessionThreshold("ses_a", 150)
    controller.setSessionThreshold("ses_b", 50)

    expect(controller.thresholdFor("ses_a")).toBe(150)
    expect(controller.observe("ses_a", 150, 0)).toBe(true)
    expect(controller.observe("ses_b", 40, 0)).toBe(false)
  })

  it("re-arms when the threshold moves", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 120, 0)).toBe(true)
    controller.requested("ses_1")
    controller.compactionEnded("ses_1")
    expect(controller.observe("ses_1", 110, 1)).toBe(false)

    controller.setSessionThreshold("ses_1", 80)
    expect(controller.observe("ses_1", 120, 2)).toBe(true)
  })

  it("does not re-arm when the effective threshold is unchanged", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    expect(controller.observe("ses_1", 120, 0)).toBe(true)
    controller.requested("ses_1")
    controller.compactionEnded("ses_1")

    // Every step re-resolves the threshold; an unchanged value must not defeat
    // the anti-loop pause after a compaction that left context above the line.
    controller.setSessionThreshold("ses_1", 100)
    expect(controller.observe("ses_1", 130, 1)).toBe(false)
  })

  it("falls back to the default after clearing an override", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    controller.setSessionThreshold("ses_1", 50)
    expect(controller.thresholdFor("ses_1")).toBe(50)
    controller.setSessionThreshold("ses_1", undefined)
    expect(controller.thresholdFor("ses_1")).toBe(100)
  })

  it("reports a readable snapshot and forgets removed sessions", () => {
    const controller = new AutoCompactController({ threshold: 100 })
    controller.observe("ses_1", 50, 0)
    expect(controller.snapshot("ses_1")).toMatchObject({
      tokens: 50,
      threshold: 100,
      percent: 0.5,
      enabled: true,
      armed: true,
      pending: false,
    })

    controller.forget("ses_1")
    expect(controller.snapshot("ses_1").tokens).toBe(0)
  })
})
