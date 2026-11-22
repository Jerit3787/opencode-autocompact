import { describe, expect, it } from "vitest"
import {
  MIN_THRESHOLD,
  isValidThreshold,
  parseSettings,
  readSessionOverride,
  resolveThreshold,
  withSessionOverride,
} from "./settings"

describe("isValidThreshold", () => {
  it("accepts integers at or above the minimum", () => {
    expect(isValidThreshold(MIN_THRESHOLD)).toBe(true)
    expect(isValidThreshold(500_000)).toBe(true)
  })

  it("rejects lower, fractional, and non-numeric values", () => {
    expect(isValidThreshold(99_999)).toBe(false)
    expect(isValidThreshold(100_000.5)).toBe(false)
    expect(isValidThreshold("500000")).toBe(false)
    expect(isValidThreshold(undefined)).toBe(false)
  })
})

describe("parseSettings", () => {
  it("keeps valid global and project values", () => {
    expect(
      parseSettings(
        {
          version: 1,
          global: { threshold: 700_000 },
          projects: { "/a": { threshold: 300_000 }, "/bad": { threshold: 10 } },
        },
        500_000,
      ),
    ).toEqual({
      version: 1,
      global: { threshold: 700_000 },
      projects: { "/a": { threshold: 300_000 } },
    })
  })

  it("falls back to an empty settings object", () => {
    expect(parseSettings(undefined, 500_000)).toEqual({
      version: 1,
      global: {},
      projects: {},
    })
    expect(parseSettings({ global: { threshold: "x" } }, 500_000)).toEqual({
      version: 1,
      global: {},
      projects: {},
    })
  })
})

describe("resolveThreshold", () => {
  it("prefers chat, then project, then global, then config", () => {
    expect(
      resolveThreshold({ config: 500_000, global: 600_000, project: 700_000, session: 800_000 }),
    ).toEqual({
      threshold: 800_000,
      source: "chat",
      global: 600_000,
      project: 700_000,
      session: 800_000,
    })

    expect(resolveThreshold({ config: 500_000, global: 600_000, project: 700_000 })).toMatchObject({
      threshold: 700_000,
      source: "project",
    })
    expect(resolveThreshold({ config: 500_000, global: 600_000 })).toMatchObject({
      threshold: 600_000,
      source: "global",
    })
    expect(resolveThreshold({ config: 500_000 })).toEqual({
      threshold: 500_000,
      source: "config",
      global: 500_000,
      project: null,
      session: null,
    })
  })

  it("ignores invalid overrides", () => {
    expect(
      resolveThreshold({ config: 500_000, global: 10, project: 20, session: 30 }),
    ).toMatchObject({ threshold: 500_000, source: "config" })
  })
})

describe("session metadata", () => {
  it("reads and merges the chat override without dropping other keys", () => {
    const metadata = withSessionOverride({ title: "keep", other: { a: 1 } }, 700_000)
    expect(metadata).toEqual({
      title: "keep",
      other: { a: 1 },
      autocompact: { threshold: 700_000 },
    })
    expect(readSessionOverride(metadata)).toBe(700_000)
  })

  it("clears only the autocompact key", () => {
    const metadata = withSessionOverride(
      { title: "keep", autocompact: { threshold: 700_000 } },
      null,
    )
    expect(metadata).toEqual({ title: "keep" })
    expect(readSessionOverride(metadata)).toBeNull()
  })

  it("tolerates missing or malformed metadata", () => {
    expect(readSessionOverride(undefined)).toBeNull()
    expect(readSessionOverride({ autocompact: { threshold: "x" } })).toBeNull()
    expect(withSessionOverride(undefined, 700_000)).toEqual({
      autocompact: { threshold: 700_000 },
    })
  })
})
