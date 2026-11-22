import { For, Show, createEffect, createSignal, onMount } from "solid-js"
import { usePlugin, type Context } from "@opencode/plugin/gui"
import { parseCommandTokenCount } from "../engine"
import { MIN_THRESHOLD } from "../settings"
import { formatTokens } from "../status"
import {
  loadSettings,
  refreshSettings,
  saveGlobal,
  saveProject,
  settingsKey,
  settingsState,
} from "./state"

const rowStyle = {
  display: "flex",
  gap: "8px",
  "align-items": "center",
  width: "360px",
} as const

const fieldStyle = { flex: "1", "min-width": "0" } as const

function compact(value: number): string {
  return value % 1_000 === 0 ? `${value / 1_000}k` : String(value)
}

function projectName(directory: string): string {
  return directory.split("/").filter(Boolean).pop() ?? directory
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(cause)
}

function invalidThreshold(): string {
  return `Enter at least ${formatTokens(MIN_THRESHOLD)} tokens, for example 500k.`
}

function ProjectRow(props: {
  ui: Context["ui"]
  directory: string
  threshold: number
  busy: boolean
  disabled: boolean
  onSave: (directory: string, raw: string) => void
  onClear: (directory: string) => void
}) {
  const [text, setText] = createSignal(compact(props.threshold))

  createEffect(() => setText(compact(props.threshold)))

  return (
    <props.ui.SettingsRow
      title={projectName(props.directory)}
      description={props.directory}
    >
      <div style={rowStyle}>
        <div style={fieldStyle}>
          <props.ui.TextInput
            label={`Threshold for ${props.directory}`}
            value={text()}
            onInput={setText}
            onSubmit={() => props.onSave(props.directory, text())}
            placeholder="Use global"
            disabled={props.disabled}
          />
        </div>
        <props.ui.Button
          variant="neutral"
          size="small"
          disabled={props.disabled}
          busy={props.busy}
          onClick={() => props.onSave(props.directory, text())}
        >
          Save
        </props.ui.Button>
        <props.ui.Button
          variant="ghost"
          size="small"
          disabled={props.disabled || props.busy}
          onClick={() => props.onClear(props.directory)}
        >
          Use global
        </props.ui.Button>
      </div>
    </props.ui.SettingsRow>
  )
}

export function AutocompactSettingsPage() {
  const ctx = usePlugin()
  const ui = ctx.ui
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal<string>()
  const [globalText, setGlobalText] = createSignal("")
  const [newProject, setNewProject] = createSignal("")

  const current = () => settingsState[settingsKey(undefined, undefined)]
  const projects = () => current()?.projects ?? []
  const degraded = () => current()?.degraded === true

  const refresh = async () => {
    setBusy("refresh")
    try {
      await refreshSettings(ctx, {})
      setError(undefined)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => {
    // Always refetch on mount: a missed `changed` event must not leave the
    // page showing values from an earlier session.
    void refreshSettings(ctx, {})
      .then(() => setError(undefined))
      .catch((cause) => setError(messageOf(cause)))
  })

  createEffect(() => {
    // A `changed` event clears the store; refetch instead of showing an
    // empty list until the page remounts.
    if (!current()) {
      void loadSettings(ctx, {}).catch((cause) => setError(messageOf(cause)))
    }
  })

  createEffect(() => {
    const payload = current()
    if (payload) setGlobalText(compact(payload.global))
  })

  const blocked = (): boolean => {
    if (!degraded()) return false
    setError("The settings file could not be read, so it was not changed.")
    return true
  }

  const saveGlobalValue = async () => {
    if (blocked()) return
    const tokens = parseCommandTokenCount(globalText())
    if (tokens === undefined || tokens < MIN_THRESHOLD) {
      setError(invalidThreshold())
      return
    }

    setError(undefined)
    setBusy("global")
    try {
      const payload = await saveGlobal(ctx, undefined, undefined, tokens)
      setGlobalText(compact(payload.global))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const saveProjectValue = async (directory: string, raw: string) => {
    if (blocked()) return
    const tokens = parseCommandTokenCount(raw)
    if (tokens === undefined || tokens < MIN_THRESHOLD) {
      setError(invalidThreshold())
      return
    }

    setError(undefined)
    setBusy(directory)
    try {
      await saveProject(ctx, directory, undefined, tokens)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const useGlobal = async (directory: string) => {
    if (blocked()) return
    setError(undefined)
    setBusy(directory)
    try {
      await saveProject(ctx, directory, undefined, null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const addProject = async () => {
    if (blocked()) return
    const directory = newProject().trim()
    const fallback = current()?.global
    if (!directory || fallback === undefined) {
      setError("Enter an absolute project directory, for example /Users/you/project.")
      return
    }

    setError(undefined)
    setBusy("new")
    try {
      const existing = await loadSettings(ctx, { directory }, true)
      if (existing.project !== null) {
        setError("That project already has an override. Edit its row instead.")
        return
      }
      await saveProject(ctx, directory, undefined, fallback)
      setNewProject("")
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <ui.SettingsLayout
      title={ctx.t("page.title")}
      description={ctx.t("page.description")}
      actions={
        <ui.Button
          variant="neutral"
          size="small"
          busy={busy() === "refresh"}
          onClick={() => void refresh()}
        >
          Refresh
        </ui.Button>
      }
    >
      <Show when={error()}>
        {(message) => (
          <div
            style={{
              color: "var(--v2-text-text-danger, #e5484d)",
              "font-size": "12px",
              "padding-bottom": "8px",
            }}
          >
            {message()}
          </div>
        )}
      </Show>

      <Show when={degraded()}>
        <div
          style={{
            color: "var(--v2-text-text-warning, #d98b0d)",
            "font-size": "12px",
            "padding-bottom": "8px",
          }}
        >
          The settings file could not be read, so saves are disabled. Fix or remove{" "}
          {current()?.settingsPath}
          {current()?.backupPath ? `; a backup is at ${current()?.backupPath}` : ""}.
        </div>
      </Show>

      <ui.SettingsSection title="Global default">
        <ui.SettingsRow
          title="Default threshold"
          description="Used when a project has no override."
        >
          <div style={rowStyle}>
            <div style={fieldStyle}>
              <ui.TextInput
                label="Global threshold"
                value={globalText()}
                onInput={setGlobalText}
                onSubmit={() => void saveGlobalValue()}
                placeholder="500k"
                disabled={degraded()}
              />
            </div>
            <ui.Button
              variant="neutral"
              size="small"
              disabled={degraded()}
              busy={busy() === "global"}
              onClick={() => void saveGlobalValue()}
            >
              Save
            </ui.Button>
          </div>
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title="Projects">
        <For each={projects()}>
          {(project) => (
            <ProjectRow
              ui={ui}
              directory={project.directory}
              threshold={project.threshold}
              busy={busy() === project.directory}
              disabled={degraded()}
              onSave={(directory, raw) => void saveProjectValue(directory, raw)}
              onClear={(directory) => void useGlobal(directory)}
            />
          )}
        </For>
        <ui.SettingsRow
          title="Add project"
          description="Add an absolute directory, then edit its threshold above. Project keys are canonical."
        >
          <div style={rowStyle}>
            <div style={fieldStyle}>
              <ui.TextInput
                label="Project directory"
                value={newProject()}
                onInput={setNewProject}
                onSubmit={() => void addProject()}
                placeholder="/Users/you/project"
                disabled={degraded()}
              />
            </div>
            <ui.Button
              variant="neutral"
              size="small"
              disabled={degraded() || !newProject().trim()}
              busy={busy() === "new"}
              onClick={() => void addProject()}
            >
              Add
            </ui.Button>
          </div>
        </ui.SettingsRow>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  )
}
