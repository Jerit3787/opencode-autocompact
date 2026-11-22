import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  AutoCompactController,
  contextTokens,
  latestContextTokens,
  parseAutocompactCommand,
  parseCommandTokenCount,
  parseTokenCount,
  type AutoCompactAction,
} from "./engine"
import { AutocompactRpc, type SettingsPayload } from "./rpc"
import { isValidThreshold, MIN_THRESHOLD, readSessionOverride, withSessionOverride } from "./settings"
import { formatStatus, formatTokens } from "./status"
import { defaultSettingsPath, getSettingsStore } from "./store"

const DEFAULT_THRESHOLD = 500_000
const DEFAULT_RETRY_AFTER_MS = 5 * 60_000
const LEGACY_SETTINGS_KEY = "settings"

const USAGE =
  "Usage: /autocompact [status | compact | auto | <tokens>]. " +
  "Examples: /autocompact 500k, /autocompact 1M, /autocompact 300 (300,000 tokens)."

const toolInput = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "compact", "set", "auto"],
      description:
        "status reports current context tokens against the threshold. compact requests compaction now. " +
        "set changes this chat's threshold using tokens. auto clears this chat's threshold and falls back to the project, global, or plugin default.",
    },
    tokens: {
      type: "string",
      description: "For action=set: 500000, 500k, 1M, or 300 (bare 100-1000 means thousands).",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}

function retryAfter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_RETRY_AFTER_MS
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Expand `~`, require an absolute path, and resolve symlinks when it exists. */
async function canonicalDirectory(value: string): Promise<string | undefined> {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? path.join(homedir(), trimmed.slice(2))
        : trimmed
  if (!path.isAbsolute(expanded)) return undefined

  const resolved = path.resolve(expanded)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

function normalizeAction(value: string | undefined): AutoCompactAction | undefined {
  switch (value) {
    case "status":
    case "compact":
    case "set":
    case "auto":
      return value
    default:
      return undefined
  }
}

export default Plugin.define({
  id: "autocompact",
  async setup(ctx) {
    const configThreshold = Math.max(
      MIN_THRESHOLD,
      parseTokenCount(ctx.options.threshold, DEFAULT_THRESHOLD),
    )
    const configEnabled = ctx.options.enabled !== false
    const settingsPath =
      typeof ctx.options.settingsPath === "string" && ctx.options.settingsPath.length > 0
        ? ctx.options.settingsPath
        : defaultSettingsPath()
    const store = getSettingsStore({ path: settingsPath, configThreshold })
    const canonical = String(ctx.location.project.canonical)

    try {
      const state = await store.readState()
      if (state.degraded) {
        console.warn(
          "[autocompact] settings file is unreadable; skipping migration and keeping the legacy key:",
          state.reason,
        )
      } else {
        const legacy = await ctx.storage.get(LEGACY_SETTINGS_KEY)
        if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
          const raw = (legacy as Record<string, unknown>).threshold
          if (raw !== undefined && !isValidThreshold(raw)) {
            console.warn("[autocompact] ignoring invalid legacy threshold:", raw)
          } else if (isValidThreshold(raw) && (await store.getProject(canonical)) === null) {
            await store.setProject(canonical, raw)
          }
        }
        await ctx.storage.remove(LEGACY_SETTINGS_KEY)
      }
    } catch (error) {
      console.warn("[autocompact] could not migrate saved settings:", error)
    }

    const controller = new AutoCompactController({
      threshold: configThreshold,
      enabled: configEnabled,
      retryAfterMs: retryAfter(ctx.options.retryAfterMs),
    })

    const message = (event: { readonly data: { readonly sessionID: string } }) =>
      String(event.data.sessionID)

    const readContext = async (sessionID: string): Promise<number> => {
      const messages = await ctx.session.context({ sessionID })
      return latestContextTokens(messages)
    }

    const modelWindow = async (sessionID: string): Promise<number | undefined> => {
      try {
        const session = await ctx.session.get({ sessionID })
        const ref = session.model
        if (!ref) return undefined
        const models = await ctx.model.list()
        return models.data.find((model) => model.providerID === ref.providerID && model.id === ref.id)
          ?.limit.context
      } catch {
        return undefined
      }
    }

    const applySessionThreshold = async (sessionID: string, directory = canonical) => {
      const session = await ctx.session.get({ sessionID })
      const override = readSessionOverride(session.metadata)
      const resolved = await store.resolve({ directory, session: override })
      controller.setSessionThreshold(sessionID, resolved.threshold)
      return resolved
    }

    const payloadFor = async (input: {
      directory?: string
      sessionID?: string
    }): Promise<SettingsPayload> => {
      const requested = input.directory?.trim()
      const directory = requested ? await canonicalDirectory(requested) : undefined
      const session = input.sessionID
        ? await ctx.session.get({ sessionID: input.sessionID })
        : undefined
      const override = directory && session ? readSessionOverride(session.metadata) : null
      const [resolved, state] = await Promise.all([
        store.resolve({ directory, session: override }),
        store.readState(),
      ])
      const projects = Object.entries(state.data.projects)
        .flatMap(([project, entry]) =>
          typeof entry.threshold === "number"
            ? [{ directory: project, threshold: entry.threshold }]
            : [],
        )
        .sort((a, b) => a.directory.localeCompare(b.directory))

      return {
        global: resolved.global,
        project: resolved.project,
        session: resolved.session,
        effective: resolved.threshold,
        source: resolved.source,
        enabled: configEnabled,
        projects,
        settingsPath,
        degraded: state.degraded,
        ...(state.backupPath ? { backupPath: state.backupPath } : {}),
      }
    }

    let notifyChanged: (input: {
      directory?: string
      sessionID?: string
    }) => Promise<void> = async () => {}

    const refreshSession = async (sessionID: string | undefined, directory?: string) => {
      if (!sessionID) return
      try {
        await applySessionThreshold(sessionID, directory)
      } catch (error) {
        console.warn(`[autocompact] could not refresh the threshold for ${sessionID}:`, error)
      }
    }

    const requestCompaction = async (sessionID: string, observed: number): Promise<boolean> => {
      controller.requested(sessionID)
      try {
        await ctx.session.compact({ sessionID })
        console.log(
          `[autocompact] requested compaction for ${sessionID} at ${formatTokens(observed)} tokens (threshold ${formatTokens(controller.thresholdFor(sessionID))})`,
        )
        return true
      } catch (error) {
        controller.compactionFailed(sessionID, Date.now())
        console.error(`[autocompact] compaction request failed for ${sessionID}:`, error)
        return false
      }
    }

    const statusFor = async (sessionID: string, directory = canonical): Promise<string> => {
      const [resolved, tokens, window] = await Promise.all([
        applySessionThreshold(sessionID, directory),
        readContext(sessionID),
        modelWindow(sessionID),
      ])

      controller.note(sessionID, tokens)
      const snapshot = controller.snapshot(sessionID)
      return formatStatus({
        threshold: resolved.threshold,
        source: resolved.source,
        tokens,
        modelWindow: window,
        enabled: snapshot.enabled,
        pending: snapshot.pending,
        armed: snapshot.armed,
        failedAt: snapshot.failedAt,
        configThreshold,
        global: resolved.global,
        project: resolved.project,
        session: resolved.session,
      })
    }

    const getContextFor = async (sessionID: string): Promise<number> => {
      const tokens = await readContext(sessionID)
      controller.note(sessionID, tokens)
      return tokens
    }

    const setThresholdFor = async (
      sessionID: string,
      tokens: number,
      directory = canonical,
    ): Promise<string> => {
      if (tokens < MIN_THRESHOLD) {
        return `Threshold must be at least ${formatTokens(MIN_THRESHOLD)} tokens. ${USAGE}`
      }

      const session = await ctx.session.get({ sessionID })
      await ctx.session.update({
        sessionID,
        metadata: withSessionOverride(session.metadata, tokens) as Parameters<typeof ctx.session.update>[0]["metadata"],
      })
      await refreshSession(sessionID, directory)
      await notifyChanged({ directory, sessionID })
      try {
        return await statusFor(sessionID, directory)
      } catch (error) {
        return `Chat threshold set to ${formatTokens(tokens)} tokens. The status could not be read: ${errorText(error)}`
      }
    }

    const resetThresholdFor = async (sessionID: string, directory = canonical): Promise<string> => {
      const session = await ctx.session.get({ sessionID })
      await ctx.session.update({
        sessionID,
        metadata: withSessionOverride(session.metadata, null) as Parameters<typeof ctx.session.update>[0]["metadata"],
      })
      await refreshSession(sessionID, directory)
      await notifyChanged({ directory, sessionID })
      try {
        return await statusFor(sessionID, directory)
      } catch (error) {
        return `Chat threshold cleared. The status could not be read: ${errorText(error)}`
      }
    }

    const compactNow = async (sessionID: string): Promise<string> => {
      const current = await getContextFor(sessionID)
      const requested = await requestCompaction(sessionID, current)
      return requested
        ? `Compaction requested at ${formatTokens(current)} tokens. It runs at the next step boundary.`
        : `Compaction request failed. Check the OpenCode log for details.`
    }

    const runAction = async (
      action: AutoCompactAction,
      argument: string | number | undefined,
      sessionID: string,
      directory = canonical,
    ): Promise<string> => {
      switch (action) {
        case "status":
          return statusFor(sessionID, directory)
        case "compact":
          return compactNow(sessionID)
        case "auto":
          return resetThresholdFor(sessionID, directory)
        case "set": {
          const tokens =
            typeof argument === "number"
              ? Math.floor(argument)
              : parseCommandTokenCount(String(argument ?? ""))
          if (tokens === undefined) {
            return `Could not read a token count from "${String(argument ?? "")}". ${USAGE}`
          }
          return setThresholdFor(sessionID, tokens, directory)
        }
      }
    }

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: abort.signal,
          types: [
            "session.step.ended",
            "session.metadata.updated",
            "session.compaction.started",
            "session.compaction.ended",
            "session.compaction.failed",
            "session.deleted",
          ],
        })) {
          switch (event.type) {
            case "session.step.ended": {
              const sessionID = message(event)
              try {
                await applySessionThreshold(sessionID)
              } catch (error) {
                console.error(`[autocompact] could not resolve the threshold for ${sessionID}:`, error)
              }
              const tokens = contextTokens(event.data.tokens)
              if (controller.observe(sessionID, tokens, Date.now())) {
                await requestCompaction(sessionID, tokens)
              }
              break
            }
            case "session.metadata.updated": {
              const sessionID = message(event)
              try {
                await applySessionThreshold(sessionID)
              } catch (error) {
                console.error(`[autocompact] could not resolve the threshold for ${sessionID}:`, error)
              }
              break
            }
            case "session.compaction.started": {
              controller.compactionStarted(message(event))
              break
            }
            case "session.compaction.ended": {
              const sessionID = message(event)
              controller.compactionEnded(sessionID)
              try {
                controller.note(sessionID, await readContext(sessionID))
              } catch (error) {
                console.error(`[autocompact] could not read context after compaction:`, error)
              }
              break
            }
            case "session.compaction.failed": {
              controller.compactionFailed(message(event), Date.now())
              break
            }
            case "session.deleted": {
              controller.forget(message(event))
              break
            }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error("[autocompact] event subscription stopped:", error)
        }
      }
    })()

    const registration = await ctx.rpc.register(AutocompactRpc, {
      get: async (input, context) => {
        const value = input as { directory?: string; sessionID?: string }
        try {
          return await payloadFor(value)
        } catch (error) {
          if (!value.sessionID) throw error
          return context.error("not_found", `Session not found: ${value.sessionID}`, {
            sessionID: value.sessionID,
          })
        }
      },
      setGlobal: async (input, context) => {
        const value = input as { directory?: string; sessionID?: string; threshold: number }
        if (!isValidThreshold(value.threshold)) {
          return context.error(
            "invalid_threshold",
            `Threshold must be at least ${formatTokens(MIN_THRESHOLD)} tokens`,
            { minimum: MIN_THRESHOLD },
          )
        }

        const directory = value.directory
          ? await canonicalDirectory(value.directory)
          : canonical
        if (!directory) {
          return context.error(
            "invalid_directory",
            "Project directory must be an absolute path.",
            { message: "Project directory must be an absolute path." },
          )
        }
        try {
          await store.setGlobal(value.threshold)
        } catch (error) {
          return context.error("write_failed", errorText(error), { message: errorText(error) })
        }

        await refreshSession(value.sessionID, directory)
        await notifyChanged({ directory, sessionID: value.sessionID })
        try {
          return await payloadFor({ directory: value.directory, sessionID: value.sessionID })
        } catch (error) {
          if (value.sessionID) {
            return context.error("not_found", `Session not found: ${value.sessionID}`, {
              sessionID: value.sessionID,
            })
          }
          throw error
        }
      },
      setProject: async (input, context) => {
        const value = input as {
          directory: string
          sessionID?: string
          threshold: number | null
        }
        if (value.threshold !== null && !isValidThreshold(value.threshold)) {
          return context.error(
            "invalid_threshold",
            `Threshold must be at least ${formatTokens(MIN_THRESHOLD)} tokens`,
            { minimum: MIN_THRESHOLD },
          )
        }

        const directory = await canonicalDirectory(value.directory)
        if (!directory) {
          return context.error(
            "invalid_directory",
            "Project directory must be an absolute path.",
            { message: "Project directory must be an absolute path." },
          )
        }

        try {
          await store.setProject(directory, value.threshold)
        } catch (error) {
          return context.error("write_failed", errorText(error), { message: errorText(error) })
        }

        await refreshSession(value.sessionID, directory)
        await notifyChanged({ directory, sessionID: value.sessionID })
        try {
          return await payloadFor({ directory, sessionID: value.sessionID })
        } catch (error) {
          if (value.sessionID) {
            return context.error("not_found", `Session not found: ${value.sessionID}`, {
              sessionID: value.sessionID,
            })
          }
          throw error
        }
      },
      setSession: async (input, context) => {
        const value = input as {
          directory: string
          sessionID: string
          threshold: number | null
        }
        if (value.threshold !== null && !isValidThreshold(value.threshold)) {
          return context.error(
            "invalid_threshold",
            `Threshold must be at least ${formatTokens(MIN_THRESHOLD)} tokens`,
            { minimum: MIN_THRESHOLD },
          )
        }

        const directory = await canonicalDirectory(value.directory)
        if (!directory) {
          return context.error(
            "invalid_directory",
            "Project directory must be an absolute path.",
            { message: "Project directory must be an absolute path." },
          )
        }

        let session
        try {
          session = await ctx.session.get({ sessionID: value.sessionID })
        } catch {
          return context.error("not_found", `Session not found: ${value.sessionID}`, {
            sessionID: value.sessionID,
          })
        }

        try {
          await ctx.session.update({
            sessionID: value.sessionID,
            metadata: withSessionOverride(session.metadata, value.threshold) as Parameters<
              typeof ctx.session.update
            >[0]["metadata"],
          })
        } catch (error) {
          return context.error("write_failed", errorText(error), { message: errorText(error) })
        }

        await refreshSession(value.sessionID, directory)
        await notifyChanged({ directory, sessionID: value.sessionID })
        try {
          return await payloadFor({ directory, sessionID: value.sessionID })
        } catch (error) {
          return context.error("not_found", `Session not found: ${value.sessionID}`, {
            sessionID: value.sessionID,
          })
        }
      },
    })

    notifyChanged = async (input) => {
      try {
        await registration.events.emit("changed", {
          ...(input.directory ? { directory: input.directory } : {}),
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        })
      } catch (error) {
        console.warn("[autocompact] could not emit the settings change event:", error)
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "autocompact",
        description: "Show or set this chat's autocompact threshold",
        execute: async ({ sessionID, prompt, delivery }) => {
          const command = parseAutocompactCommand(prompt.text)
          const action = normalizeAction(command.action)
          let result: string
          try {
            result = action
              ? await runAction(action, command.argument, String(sessionID))
              : USAGE
          } catch (error) {
            result = `Autocompact failed: ${errorText(error)}`
          }

          await ctx.session.synthetic({
            sessionID,
            text: result,
            description: "Autocompact",
            delivery,
            resume: false,
          })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "autocompact",
        description:
          "Inspect or control automatic context compaction for this session. The plugin compacts automatically when the context reaches its threshold. " +
          "Use action=status to see the current context size against the threshold, action=compact to request compaction now, action=set with tokens to change this chat's threshold, " +
          "action=auto to clear this chat's override and fall back to the project, global, or plugin default.",
        input: toolInput,
        options: { codemode: false },
        execute: async (raw, context) => {
          const sessionID = String(context.sessionID)
          const input = raw as { action?: string; tokens?: string }
          const action = normalizeAction(input.action ?? "status")

          if (!action) return text(USAGE)

          try {
            return text(await runAction(action, input.tokens, sessionID))
          } catch (error) {
            return text(`Autocompact failed: ${errorText(error)}`)
          }
        },
      })
    })

    return () => {
      abort.abort()
    }
  },
})
