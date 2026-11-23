import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getSettingsStore } from "./store"

const dirs: string[] = []

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "autocompact-store-"))
  dirs.push(dir)
  let clock = 1_000
  const file = path.join(dir, "autocompact.json")
  const store = getSettingsStore({ path: file, configThreshold: 500_000, now: () => clock })
  return {
    dir,
    file,
    store,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("SettingsStore", () => {
  it("uses the config fallback when the file is missing", async () => {
    const { store } = await tempStore()
    await expect(store.resolve({ directory: "/a" })).resolves.toEqual({
      threshold: 500_000,
      source: "config",
      global: 500_000,
      project: null,
      session: null,
    })
  })

  it("writes and resolves global and project values", async () => {
    const { store } = await tempStore()
    await store.setGlobal(700_000)
    await store.setProject("/a", 300_000)

    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 300_000,
      source: "project",
    })
    await expect(store.resolve({ directory: "/b" })).resolves.toMatchObject({
      threshold: 700_000,
      source: "global",
    })
    await expect(store.resolve({ directory: "/a", session: 800_000 })).resolves.toMatchObject({
      threshold: 800_000,
      source: "chat",
    })
  })

  it("clears a project override back to the global value", async () => {
    const { store } = await tempStore()
    await store.setGlobal(600_000)
    await store.setProject("/a", 300_000)
    await store.setProject("/a", null)
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 600_000,
      source: "global",
    })
  })

  it("falls back and does not overwrite a corrupt file", async () => {
    const { file, store } = await tempStore()
    await writeFile(file, "{not json", "utf8")
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 500_000,
      source: "config",
    })
    await expect(readFile(file, "utf8")).resolves.toBe("{not json")
  })

  it("refuses to overwrite a corrupt file and keeps a backup", async () => {
    const { file, store } = await tempStore()
    await writeFile(file, "{not json", "utf8")

    const state = await store.readState(true)
    expect(state.degraded).toBe(true)
    expect(state.backupPath).toBe(`${file}.bak`)

    await expect(store.setGlobal(600_000)).rejects.toThrow(/could not be read/)
    await expect(store.setProject("/a", 600_000)).rejects.toThrow(/could not be read/)
    await expect(readFile(file, "utf8")).resolves.toBe("{not json")
    await expect(readFile(`${file}.bak`, "utf8")).resolves.toBe("{not json")
  })

  it("adopts a changed config fallback on the shared store", async () => {
    const { file } = await tempStore()
    const store = getSettingsStore({
      path: file,
      configThreshold: 700_000,
      now: () => 2_000,
    })
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 700_000,
      source: "config",
    })
  })

  it("picks up an external file change after the mtime throttle", async () => {
    const { file, store, advance } = await tempStore()
    await store.setGlobal(600_000)
    await writeFile(
      file,
      JSON.stringify({ version: 1, global: { threshold: 800_000 }, projects: {} }),
      "utf8",
    )
    advance(1_001)
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 800_000,
      source: "global",
    })
  })

  it("serializes concurrent writes and leaves no temp files", async () => {
    const { dir, store } = await tempStore()
    await Promise.all([store.setGlobal(600_000), store.setProject("/a", 700_000)])
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 700_000,
      source: "project",
    })
    const entries = await readdir(dir)
    expect(entries).toEqual(["autocompact.json"])
  })
})
