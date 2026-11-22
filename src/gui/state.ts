import { createStore, reconcile } from "solid-js/store"
import type { Context } from "@opencode/plugin/gui"
import { AutocompactRpc, type SettingsPayload } from "../rpc"

export function settingsKey(directory: string | undefined, sessionID: string | undefined): string {
  return `${directory ?? ""}\n${sessionID ?? ""}`
}

const [settingsState, setSettingsState] = createStore<Record<string, SettingsPayload>>({})
export { settingsState }

const inFlight = new Map<string, Promise<SettingsPayload>>()

function remember(key: string, payload: SettingsPayload): SettingsPayload {
  setSettingsState(key, payload)
  return payload
}

function client(ctx: Context) {
  return ctx.client.rpc(AutocompactRpc)
}

export async function loadSettings(
  ctx: Context,
  input: { directory?: string; sessionID?: string },
): Promise<SettingsPayload> {
  const key = settingsKey(input.directory, input.sessionID)
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = client(ctx)
    .get(input)
    .then((payload) => remember(key, payload as SettingsPayload))
    .finally(() => inFlight.delete(key))

  inFlight.set(key, request)
  return request
}

export async function saveGlobal(
  ctx: Context,
  directory: string | undefined,
  sessionID: string | undefined,
  threshold: number,
): Promise<SettingsPayload> {
  const key = settingsKey(directory, sessionID)
  const payload = await client(ctx).setGlobal({ directory, sessionID, threshold })
  return remember(key, payload as SettingsPayload)
}

export async function saveProject(
  ctx: Context,
  directory: string,
  sessionID: string | undefined,
  threshold: number | null,
): Promise<SettingsPayload> {
  const key = settingsKey(directory, sessionID)
  const payload = await client(ctx).setProject({ directory, sessionID, threshold })
  return remember(key, payload as SettingsPayload)
}

export async function clearSession(
  ctx: Context,
  directory: string,
  sessionID: string,
): Promise<SettingsPayload> {
  const key = settingsKey(directory, sessionID)
  const payload = await client(ctx).setSession({ directory, sessionID, threshold: null })
  return remember(key, payload as SettingsPayload)
}

export function subscribeSettings(ctx: Context): () => void {
  try {
    return client(ctx).events.on("changed", () => {
      setSettingsState(reconcile({} as Record<string, SettingsPayload>, { merge: false }))
    })
  } catch {
    return () => {}
  }
}

export const refreshSettings = loadSettings
