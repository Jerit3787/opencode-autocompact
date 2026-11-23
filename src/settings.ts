export const MIN_THRESHOLD = 100_000

export type ThresholdSource = "chat" | "project" | "global" | "config"

export type SettingsData = {
  version: 1
  global: { threshold?: number }
  projects: Record<string, { threshold?: number }>
}

export type EffectiveThreshold = {
  threshold: number
  source: ThresholdSource
  global: number
  project: number | null
  session: number | null
}

export function isValidThreshold(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_THRESHOLD
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseSettings(value: unknown, _fallback: number): SettingsData {
  const settings: SettingsData = { version: 1, global: {}, projects: {} }
  const input = record(value)
  if (!input) return settings

  const global = record(input.global)
  if (global && isValidThreshold(global.threshold)) settings.global.threshold = global.threshold
  else if (global?.threshold !== undefined) {
    console.warn("[autocompact] ignoring invalid global threshold:", global.threshold)
  }

  const projects = record(input.projects)
  if (!projects) return settings

  for (const [directory, entry] of Object.entries(projects)) {
    const project = record(entry)
    if (project && isValidThreshold(project.threshold)) {
      settings.projects[directory] = { threshold: project.threshold }
    } else if (project?.threshold !== undefined) {
      console.warn(
        `[autocompact] ignoring invalid threshold for ${directory}:`,
        project.threshold,
      )
    }
  }
  return settings
}

export function resolveThreshold(input: {
  config: number
  global?: number
  project?: number | null
  session?: number | null
}): EffectiveThreshold {
  const global = isValidThreshold(input.global) ? input.global : input.config
  const project = isValidThreshold(input.project) ? input.project : null
  const session = isValidThreshold(input.session) ? input.session : null

  if (session !== null) {
    return { threshold: session, source: "chat", global, project, session }
  }
  if (project !== null) {
    return { threshold: project, source: "project", global, project, session }
  }
  if (isValidThreshold(input.global)) {
    return { threshold: global, source: "global", global, project, session }
  }
  return { threshold: input.config, source: "config", global, project, session }
}

export function readSessionOverride(metadata: unknown): number | null {
  const root = record(metadata)
  const autocompact = record(root?.autocompact)
  return isValidThreshold(autocompact?.threshold) ? autocompact.threshold : null
}

export function withSessionOverride(
  metadata: unknown,
  threshold: number | null,
): Record<string, unknown> {
  const root = { ...(record(metadata) ?? {}) }
  if (threshold === null) {
    delete root.autocompact
    return root
  }

  const existing = record(root.autocompact)
  root.autocompact = { ...(existing ?? {}), threshold }
  return root
}
