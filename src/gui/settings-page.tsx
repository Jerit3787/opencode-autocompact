import { For, Show, createEffect, createSignal } from "solid-js"
import { usePlugin, type Context } from "@opencode/plugin/gui"
import { parseCommandTokenCount } from "../engine"
import { MIN_THRESHOLD } from "../settings"
import { formatTokens } from "../status"
import { loadSettings, saveGlobal, saveProject, settingsKey, settingsState } from "./state"

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
  return cause instanceof Error ? cause.message : String(cause)
}

function invalidThreshold(): string {
  return `Enter at least ${formatTokens(MIN_THRESHOLD)} tokens, for example 500k.`
}

function ProjectRow(props: {
  ui: Context["ui"]
  directory: string
  threshold: number
  busy: boolean
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
          />
        </div>
        <props.ui.Button
          variant="neutral"
          size="small"
          busy={props.busy}
          onClick={() => props.onSave(props.directory, text())}
        >
          Save
        </props.ui.Button>
        <props.ui.Button
          variant="ghost"
          size="small"
          disabled={props.busy}
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

  const saveGlobalValue = async () => {
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
    const directory = newProject().trim()
    const fallback = current()?.global
    if (!directory || fallback === undefined) {
      setError("Enter a project directory, for example /Users/you/project.")
      return
    }

    setError(undefined)
    setBusy("new")
    try {
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
      title="Autocompact"
      description="Choose when OpenCode summarizes context."
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
              />
            </div>
            <ui.Button
              variant="neutral"
              size="small"
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
              onSave={(directory, raw) => void saveProjectValue(directory, raw)}
              onClear={(directory) => void useGlobal(directory)}
            />
          )}
        </For>
        <ui.SettingsRow
          title="Add project"
          description="Add a directory, then edit its threshold above."
        >
          <div style={rowStyle}>
            <div style={fieldStyle}>
              <ui.TextInput
                label="Project directory"
                value={newProject()}
                onInput={setNewProject}
                onSubmit={() => void addProject()}
                placeholder="/Users/you/project"
              />
            </div>
            <ui.Button
              variant="neutral"
              size="small"
              disabled={!newProject().trim()}
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
