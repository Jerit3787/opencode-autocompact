import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import {
  parseSettings,
  resolveThreshold,
  type EffectiveThreshold,
  type SettingsData,
} from "./settings"

export type SettingsStoreOptions = {
  path: string
  configThreshold: number
  now?: () => number
}

export type SettingsStore = {
  read(force?: boolean): Promise<SettingsData>
  resolve(input: {
    directory?: string
    session?: number | null
    force?: boolean
  }): Promise<EffectiveThreshold>
  getProject(directory: string): Promise<number | null>
  setGlobal(threshold: number): Promise<SettingsData>
  setProject(directory: string, threshold: number | null): Promise<SettingsData>
}

const CACHE_MS = 1_000
const STORE_KEY = Symbol.for("opencode-autocompact.settings")

class FileSettingsStore implements SettingsStore {
  private readonly options: SettingsStoreOptions
  private cache: SettingsData | undefined
  private mtimeMs = 0
  private size = -1
  private lastCheck = Number.NEGATIVE_INFINITY
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: SettingsStoreOptions) {
    this.options = options
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private fallback(): SettingsData {
    return parseSettings(undefined, this.options.configThreshold)
  }

  async read(force = false): Promise<SettingsData> {
    const now = this.now()
    if (!force && this.cache && now - this.lastCheck < CACHE_MS) return this.cache

    let info
    try {
      info = await stat(this.options.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[autocompact] could not stat ${this.options.path}:`, error)
      }
      this.cache = this.fallback()
      this.mtimeMs = 0
      this.size = -1
      this.lastCheck = now
      return this.cache
    }

    if (this.cache && info.mtimeMs === this.mtimeMs && info.size === this.size) {
      this.lastCheck = now
      return this.cache
    }

    let data = this.fallback()
    try {
      const value = JSON.parse(await readFile(this.options.path, "utf8"))
      data = parseSettings(value, this.options.configThreshold)
    } catch (error) {
      console.warn(`[autocompact] could not read ${this.options.path}:`, error)
    }

    this.cache = data
    this.mtimeMs = info.mtimeMs
    this.size = info.size
    this.lastCheck = now
    return data
  }

  async resolve(input: {
    directory?: string
    session?: number | null
    force?: boolean
  }): Promise<EffectiveThreshold> {
    const data = await this.read(input.force)
    return resolveThreshold({
      config: this.options.configThreshold,
      global: data.global.threshold,
      project: input.directory ? data.projects[input.directory]?.threshold : undefined,
      session: input.session,
    })
  }

  async getProject(directory: string): Promise<number | null> {
    const data = await this.read()
    return data.projects[directory]?.threshold ?? null
  }

  setGlobal(threshold: number): Promise<SettingsData> {
    return this.enqueue(async () => {
      const data = await this.read(true)
      const next: SettingsData = { ...data, global: { ...data.global, threshold } }
      await this.writeNow(next)
      return next
    })
  }

  setProject(directory: string, threshold: number | null): Promise<SettingsData> {
    return this.enqueue(async () => {
      const data = await this.read(true)
      const projects = { ...data.projects }
      if (threshold === null) delete projects[directory]
      else projects[directory] = { threshold }
      const next: SettingsData = { ...data, projects }
      await this.writeNow(next)
      return next
    })
  }

  private async writeNow(data: SettingsData): Promise<void> {
    const file = this.options.path
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8")
    await rename(temporary, file)

    const info = await stat(file)
    this.cache = data
    this.mtimeMs = info.mtimeMs
    this.size = info.size
    this.lastCheck = this.now()
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

type StoreGlobals = {
  [STORE_KEY]?: Map<string, SettingsStore>
}

function globalStores(): Map<string, SettingsStore> {
  const global = globalThis as unknown as StoreGlobals
  return (global[STORE_KEY] ??= new Map())
}

export function getSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const stores = globalStores()
  const existing = stores.get(options.path)
  if (existing) return existing

  const store = new FileSettingsStore(options)
  stores.set(options.path, store)
  return store
}

export function defaultSettingsPath(): string {
  return path.join(homedir(), ".config", "opencode", "autocompact.json")
}
