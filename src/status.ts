import type { ThresholdSource } from "./settings"

export type StatusInput = {
  threshold: number
  source: ThresholdSource
  tokens: number
  modelWindow?: number
  enabled: boolean
  pending: boolean
  armed: boolean
  failedAt?: number
  configThreshold: number
  global: number
  project: number | null
  session: number | null
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)))
}

export function thresholdWarning(threshold: number, window: number | undefined): string | undefined {
  if (window === undefined || threshold < window) return undefined
  return (
    `Warning: this model's context window is ${formatTokens(window)} tokens, ` +
    `so a ${formatTokens(threshold)}-token threshold will never be reached. ` +
    `Lower the threshold or switch to a model with a larger window.`
  )
}

export function formatStatus(input: StatusInput): string {
  const percent = input.threshold > 0 ? (input.tokens / input.threshold) * 100 : 0
  const lines = [
    `Autocompact threshold: ${formatTokens(input.threshold)} tokens (${input.source})`,
    `Current context: ${formatTokens(input.tokens)} tokens (${percent.toFixed(1)}%)`,
  ]

  if (!input.enabled) {
    lines.push("Auto-compaction is disabled.")
  } else if (input.pending) {
    lines.push("A compaction request is pending. It runs at the next step boundary.")
  } else if (input.failedAt !== undefined) {
    lines.push("The last compaction failed. The plugin will retry after its backoff.")
  } else if (input.tokens >= input.threshold && !input.armed) {
    lines.push("Auto-compaction is paused until context drops below the threshold.")
  } else {
    lines.push("Auto-compaction is armed.")
  }

  if (input.modelWindow !== undefined) {
    lines.push(`Model context window: ${formatTokens(input.modelWindow)} tokens.`)
  }

  if (input.global !== input.configThreshold || input.source === "project" || input.source === "chat") {
    lines.push(`Global default: ${formatTokens(input.global)} tokens.`)
  }

  if (input.project !== null && input.source === "chat") {
    lines.push(`Project override: ${formatTokens(input.project)} tokens.`)
  }

  if (input.modelWindow !== undefined) {
    const warning = thresholdWarning(input.threshold, input.modelWindow)
    if (warning) lines.push(warning)
  }

  return lines.join("\n")
}
