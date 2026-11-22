import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  message: undefined as { tokens: Record<string, unknown> } | undefined,
}))

vi.mock("@opencode/client/solid", () => ({
  lastAssistantWithUsage: () => state.message,
}))

import { autocompactPillView } from "./pill"

const session = {
  id: "ses_1",
  server: {
    data: {
      session: {
        message: { list: () => [] },
        get: () => ({}),
      },
    },
  },
} as never

const payload = {
  global: 500_000,
  project: 600_000,
  session: null,
  effective: 600_000,
  source: "project" as const,
  enabled: true,
  projects: [],
  settingsPath: "/tmp/autocompact.json",
  degraded: false,
}

describe("autocompactPillView", () => {
  beforeEach(() => {
    state.message = { tokens: { input: 243_000 } }
  })

  it("labels current tokens against the effective threshold", () => {
    const view = autocompactPillView({ session, payload, override: null })
    expect(view?.label).toBe("243k / 600k")
    expect(view?.tone).toBeUndefined()
    expect(view?.rows).toEqual([
      { id: "source", label: "Source", detail: "Project" },
      { id: "global", label: "Global", detail: "500k" },
      { id: "project", label: "Project", detail: "600k" },
    ])
  })

  it("warns at 80% and turns danger at 90%", () => {
    state.message = { tokens: { input: 490_000 } }
    expect(autocompactPillView({ session, payload, override: null })?.tone).toBe("warning")
    state.message = { tokens: { input: 540_000 } }
    expect(autocompactPillView({ session, payload, override: null })?.tone).toBe("danger")
  })

  it("uses a chat override and offers a reset", () => {
    const run = vi.fn()
    state.message = { tokens: { input: 243_000 } }
    const view = autocompactPillView({
      session,
      payload,
      override: 700_000,
      onReset: run,
    })
    expect(view?.label).toBe("243k / 700k")
    expect(view?.rows?.[0]).toEqual({ id: "source", label: "Source", detail: "Chat" })
    const reset = view?.rows?.find((row) => row.id === "reset")
    expect(reset?.label).toBe("Reset chat override")
    reset?.run?.()
    expect(run).toHaveBeenCalled()
  })

  it("renders nothing without usage", () => {
    state.message = undefined
    expect(autocompactPillView({ session, payload, override: null })).toBeUndefined()
  })
})
