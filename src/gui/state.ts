import { createStore, reconcile } from "solid-js/store"
import type { Context } from "@opencode/plugin/gui"
import { AutocompactRpc, type SettingsPayload } from "../rpc"

export function settingsKey(directory: string | undefined, sessionID: string | undefined): string {
  return `${directory ?? ""}\n${sessionID ?? ""}`
}

const [settingsState, setSettingsState] = createStore<Record<string, SettingsPayload>>({})
export { settingsState }

const inFlight = new Map<string, Promise<SettingsPayload>>()
const versions = new Map<string, number>()
const loadedAt = new Map<string, number>()
let epoch = 0

function versionOf(key: string): number {
  return versions.get(key) ?? 0
}

function bump(key: string): void {
  versions.set(key, versionOf(key) + 1)
  inFlight.delete(key)
}

function remember(key: string, payload: SettingsPayload): SettingsPayload {
  setSettingsState(key, payload)
  loadedAt.set(key, Date.now())

  // A project save is keyed by its directory, while the Settings page reads
  // the directory-less key. Merge the shared fields so an Add/Save updates the
  // list even if the `changed` event is missed.
  const pageKey = settingsKey(undefined, undefined)
  if (key !== pageKey && settingsState[pageKey]) {
    setSettingsState(pageKey, {
      ...settingsState[pageKey],
      global: payload.global,
      projects: payload.projects,
      settingsPath: payload.settingsPath,
      degraded: payload.degraded,
      backupPath: payload.backupPath,
    })
  }

  return payload
}

function client(ctx: Context) {
  return ctx.client.rpc(AutocompactRpc)
}

export async function loadSettings(
  ctx: Context,
  input: { directory?: string; sessionID?: string },
  force = false,
): Promise<SettingsPayload> {
  const key = settingsKey(input.directory, input.sessionID)
  if (force) bump(key)

  const pending = inFlight.get(key)
  if (pending) return pending

  const capturedEpoch = epoch
  const capturedVersion = versionOf(key)
  let request: Promise<SettingsPayload>

  request = client(ctx)
    .get(input)
    .then((raw) => {
      const payload = raw as SettingsPayload
      if (capturedEpoch !== epoch || capturedVersion !== versionOf(key)) return payload
      return remember(key, payload)
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key)
    })

  inFlight.set(key, request)
  return request
}

/** Refetch at most once per interval; used by the pill on every render. */
export async function ensureSettings(
  ctx: Context,
  input: { directory?: string; sessionID?: string },
  maxAgeMs = 2_000,
): Promise<SettingsPayload | undefined> {
  const key = settingsKey(input.directory, input.sessionID)
  const cached = settingsState[key]
  if (cached && Date.now() - (loadedAt.get(key) ?? 0) < maxAgeMs) return cached

  const pending = inFlight.get(key)
  if (pending) return pending
  return loadSettings(ctx, input)
}

export async function saveGlobal(
  ctx: Context,
  directory: string | undefined,
  sessionID: string | undefined,
  threshold: number,
): Promise<SettingsPayload> {
  const key = settingsKey(directory, sessionID)
  const payload = (await client(ctx).setGlobal({ directory, sessionID, threshold })) as SettingsPayload
  bump(key)
  return remember(key, payload)
}

export async function saveProject(
  ctx: Context,
  directory: string,
  sessionID: string | undefined,
  threshold: number | null,
): Promise<SettingsPayload> {
  const key = settingsKey(directory, sessionID)
  const payload = (await client(ctx).setProject({ directory, sessionID, threshold })) as SettingsPayload
  bump(key)
  return remember(key, payload)
}

export async function clearSession(
  ctx: Context,
  directory: string,
  sessionID: string,
): Promise<SettingsPayload> {
  const key = settingsKey(directory, sessionID)
  const payload = (await client(ctx).setSession({
    directory,
    sessionID,
    threshold: null,
  })) as SettingsPayload
  bump(key)
  return remember(key, payload)
}

export function subscribeSettings(ctx: Context): () => void {
  try {
    return client(ctx).events.on("changed", () => {
      epoch += 1
      inFlight.clear()
      versions.clear()
      loadedAt.clear()
      setSettingsState(reconcile({} as Record<string, SettingsPayload>, { merge: false }))
    })
  } catch {
    return () => {}
  }
}

export const refreshSettings = (
  ctx: Context,
  input: { directory?: string; sessionID?: string },
): Promise<SettingsPayload> => loadSettings(ctx, input, true)
