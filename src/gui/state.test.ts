import { describe, expect, it } from "vitest"
import type { SettingsPayload } from "../rpc"
import { loadSettings, saveGlobal, saveProject, settingsKey, settingsState } from "./state"

function payload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    global: 500_000,
    project: null,
    session: null,
    effective: 500_000,
    source: "config",
    enabled: true,
    projects: [],
    settingsPath: "/tmp/autocompact.json",
    degraded: false,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("GUI settings state", () => {
  it("does not let a load started before a save overwrite the saved value", async () => {
    const key = settingsKey("/generation", "ses_1")
    const pending = deferred<SettingsPayload>()
    const ctx = {
      client: {
        rpc: () => ({
          get: () => pending.promise,
          setGlobal: async () => payload({ global: 700_000 }),
          events: { on: () => () => {} },
        }),
      },
    } as never

    const loading = loadSettings(ctx, { directory: "/generation", sessionID: "ses_1" })
    await saveGlobal(ctx, "/generation", "ses_1", 700_000)
    expect(settingsState[key]?.global).toBe(700_000)

    pending.resolve(payload({ global: 500_000 }))
    await loading
    expect(settingsState[key]?.global).toBe(700_000)
  })

  it("merges a project save into the page payload", async () => {
    const project = { directory: "/merge", threshold: 650_000 }
    const ctx = {
      client: {
        rpc: () => ({
          get: async () => payload(),
          setProject: async () => payload({ projects: [project] }),
          events: { on: () => () => {} },
        }),
      },
    } as never

    await loadSettings(ctx, {})
    await saveProject(ctx, "/merge", undefined, 650_000)
    expect(settingsState[settingsKey(undefined, undefined)]?.projects).toEqual([project])
  })
})
