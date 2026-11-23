import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
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

export type SettingsRead = {
  data: SettingsData
  /** The file exists but could not be read or parsed; writes must not replace it. */
  degraded: boolean
  reason?: string
  backupPath?: string
}

export type SettingsStore = {
  read(force?: boolean): Promise<SettingsData>
  readState(force?: boolean): Promise<SettingsRead>
  resolve(input: {
    directory?: string
    session?: number | null
    force?: boolean
  }): Promise<EffectiveThreshold>
  getProject(directory: string): Promise<number | null>
  setGlobal(threshold: number): Promise<SettingsData>
  setProject(directory: string, threshold: number | null): Promise<SettingsData>
  /** Keep the cache and queue, but adopt a changed plugin option. */
  configure(options: Partial<Pick<SettingsStoreOptions, "configThreshold" | "now">>): void
}

const CACHE_MS = 1_000
// Bump the version when the SettingsStore shape changes: the map survives
// plugin reloads on the same server, so an older instance must not be reused.
const STORE_KEY = Symbol.for("opencode-autocompact.settings.v2")

class FileSettingsStore implements SettingsStore {
  private readonly filePath: string
  private cache: SettingsRead | undefined
  private configThreshold: number
  private nowFn: (() => number) | undefined
  private mtimeMs = 0
  private size = -1
  private lastCheck = Number.NEGATIVE_INFINITY
  private backedUpMtime = -1
  private version = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.path
    this.configThreshold = options.configThreshold
    this.nowFn = options.now
  }

  private get file(): string {
    return this.filePath
  }

  private now(): number {
    return this.nowFn?.() ?? Date.now()
  }

  private fallback(): SettingsData {
    return parseSettings(undefined, this.configThreshold)
  }

  configure(options: Partial<Pick<SettingsStoreOptions, "configThreshold" | "now">>): void {
    if (options.configThreshold !== undefined) this.configThreshold = options.configThreshold
    if ("now" in options) this.nowFn = options.now
    this.cache = undefined
    this.lastCheck = Number.NEGATIVE_INFINITY
  }

  async read(force = false): Promise<SettingsData> {
    return (await this.readState(force)).data
  }

  async readState(force = false): Promise<SettingsRead> {
    const now = this.now()
    if (!force && this.cache && now - this.lastCheck < CACHE_MS) return this.cache

    const file = this.file
    const version = this.version
    let info
    try {
      info = await stat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.commit(
          version,
          { data: this.fallback(), degraded: false },
          now,
          0,
          -1,
        )
      }

      const message = `could not stat ${file}: ${errorText(error)}`
      console.warn(`[autocompact] ${message}`)
      return this.commit(
        version,
        { data: this.fallback(), degraded: true, reason: message },
        now,
        0,
        -1,
      )
    }

    if (this.cache && info.mtimeMs === this.mtimeMs && info.size === this.size) {
      this.lastCheck = now
      return this.cache
    }

    let state: SettingsRead = { data: this.fallback(), degraded: false }
    try {
      const value = JSON.parse(await readFile(file, "utf8"))
      state = { data: parseSettings(value, this.configThreshold), degraded: false }
    } catch (error) {
      const message = `could not read ${file}: ${errorText(error)}`
      console.warn(`[autocompact] ${message}`)
      const backupPath = await this.backup(info.mtimeMs)
      state = {
        data: this.fallback(),
        degraded: true,
        reason: message,
        backupPath,
      }
    }

    return this.commit(version, state, now, info.mtimeMs, info.size)
  }

  async resolve(input: {
    directory?: string
    session?: number | null
    force?: boolean
  }): Promise<EffectiveThreshold> {
    const data = await this.read(input.force)
    return resolveThreshold({
      config: this.configThreshold,
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
      const data = await this.writableData()
      const next: SettingsData = { ...data, global: { ...data.global, threshold } }
      await this.writeNow(next)
      return next
    })
  }

  setProject(directory: string, threshold: number | null): Promise<SettingsData> {
    return this.enqueue(async () => {
      const data = await this.writableData()
      const projects = { ...data.projects }
      if (threshold === null) delete projects[directory]
      else projects[directory] = { threshold }
      const next: SettingsData = { ...data, projects }
      await this.writeNow(next)
      return next
    })
  }

  private async writableData(): Promise<SettingsData> {
    const state = await this.readState(true)
    if (!state.degraded) return state.data

    const backup = state.backupPath ? ` A backup is at ${state.backupPath}.` : ""
    throw new Error(
      `The autocompact settings file could not be read, so it was not overwritten.${backup}`,
    )
  }

  private async backup(mtimeMs: number): Promise<string | undefined> {
    if (this.backedUpMtime === mtimeMs) return `${this.file}.bak`

    const target = `${this.file}.bak`
    try {
      await copyFile(this.file, target)
      this.backedUpMtime = mtimeMs
      return target
    } catch (error) {
      console.warn(`[autocompact] could not back up ${this.file}:`, error)
      return undefined
    }
  }

  private commit(
    version: number,
    state: SettingsRead,
    now: number,
    mtimeMs: number,
    size: number,
  ): SettingsRead {
    // A write that finished while this read was in flight owns the cache.
    if (version !== this.version) return state

    this.cache = state
    this.mtimeMs = mtimeMs
    this.size = size
    this.lastCheck = now
    return state
  }

  private async writeNow(data: SettingsData): Promise<void> {
    const file = this.file
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8")
    await rename(temporary, file)
    this.version += 1

    // A stat failure after a successful rename must not turn the write into an
    // error; clear the timestamps so the next read re-checks the file.
    try {
      const info = await stat(file)
      this.cache = { data, degraded: false }
      this.mtimeMs = info.mtimeMs
      this.size = info.size
      this.lastCheck = this.now()
    } catch (error) {
      console.warn(`[autocompact] could not stat ${file} after writing:`, error)
      this.cache = { data, degraded: false }
      this.mtimeMs = 0
      this.size = -1
      this.lastCheck = Number.NEGATIVE_INFINITY
    }
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
  if (existing) {
    existing.configure({
      configThreshold: options.configThreshold,
      now: options.now,
    })
    return existing
  }

  const store = new FileSettingsStore(options)
  stores.set(options.path, store)
  return store
}

export function defaultSettingsPath(): string {
  return path.join(homedir(), ".config", "opencode", "autocompact.json")
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
