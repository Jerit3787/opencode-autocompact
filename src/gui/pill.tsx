import type { ComposerPillView, MountedSession } from "@opencode/plugin/gui"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { contextTokens } from "../engine"
import type { SettingsPayload } from "../rpc"

export type AutocompactPillView = {
  label: string
  tone?: "success" | "warning" | "danger"
  title?: string
  rows?: Array<{ id: string; label: string; detail?: string; run?: () => void }>
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 0,
  })
    .format(value)
    .toLowerCase()
}

function sourceLabel(source: SettingsPayload["source"]): string {
  switch (source) {
    case "chat":
      return "Chat"
    case "project":
      return "Project"
    case "global":
      return "Global"
    case "config":
      return "Config"
  }
}

export function autocompactPillView(input: {
  session: MountedSession
  payload: SettingsPayload
  override: number | null
  onReset?: () => void
}): AutocompactPillView | undefined {
  try {
    const messages = input.session.server.data.session.message.list(input.session.id)
    const info = input.session.server.data.session.get(input.session.id)
    const message = lastAssistantWithUsage(messages, info?.revert?.messageID)
    if (!message) return undefined

    const tokens = contextTokens(message.tokens)
    const effective = input.override ?? input.payload.effective
    if (!(effective > 0) || tokens <= 0) return undefined

    const percent = (tokens / effective) * 100
    const source = input.override !== null ? "Chat" : sourceLabel(input.payload.source)
    const rows: AutocompactPillView["rows"] = [
      { id: "source", label: "Source", detail: source },
      { id: "global", label: "Global", detail: format(input.payload.global) },
      {
        id: "project",
        label: "Project",
        detail: input.payload.project === null ? "Inherit" : format(input.payload.project),
      },
    ]

    if (input.override !== null && input.onReset) {
      rows.push({ id: "reset", label: "Reset chat override", run: input.onReset })
    }

    return {
      label: `${format(tokens)} / ${format(effective)}`,
      tone: percent >= 90 ? "danger" : percent >= 80 ? "warning" : undefined,
      title: `Autocompact: ${format(tokens)} of ${format(effective)} tokens (${source})`,
      rows,
    }
  } catch {
    return undefined
  }
}

export type { ComposerPillView }
