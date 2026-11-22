import { Plugin } from "@opencode/plugin"
import {
  AutoCompactController,
  contextTokens,
  latestContextTokens,
  parseAutocompactCommand,
  parseCommandTokenCount,
  parseTokenCount,
  type AutoCompactAction,
  type SessionSnapshot,
} from "./engine"

const DEFAULT_THRESHOLD = 500_000
const DEFAULT_RETRY_AFTER_MS = 5 * 60_000
const SETTINGS_KEY = "settings"
const MIN_COMMAND_THRESHOLD = 100_000

const USAGE =
  "Usage: /autocompact [status | compact | auto | <tokens>]. " +
  "Examples: /autocompact 500k, /autocompact 1M, /autocompact 300 (300,000 tokens)."

type StoredSettings = {
  threshold?: number
}

const toolInput = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "compact", "set", "auto"],
      description:
        "status reports current context tokens against the threshold. compact requests compaction now. " +
        "set changes the threshold using tokens. auto restores the plugin config.",
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

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)))
}

function retryAfter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_RETRY_AFTER_MS
}

function readStoredSettings(value: unknown): StoredSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const stored: StoredSettings = {}
  if (typeof input.threshold === "number" && Number.isFinite(input.threshold) && input.threshold > 0) {
    stored.threshold = Math.floor(input.threshold)
  }
  return stored
}

function describe(snapshot: SessionSnapshot, configThreshold: number, stored: StoredSettings): string {
  const source =
    stored.threshold === undefined ? "from plugin config" : "set with /autocompact"
  const lines = [
    `Autocompact threshold: ${formatTokens(snapshot.threshold)} tokens (${source})`,
    `Current context: ${formatTokens(snapshot.tokens)} tokens (${(snapshot.percent * 100).toFixed(1)}%)`,
  ]

  if (!snapshot.enabled) {
    lines.push("Auto-compaction is disabled. Run /autocompact on to re-enable it.")
  } else if (snapshot.pending) {
    lines.push("A compaction request is pending. It runs at the next step boundary.")
  } else if (snapshot.tokens >= snapshot.threshold) {
    lines.push(
      snapshot.failedAt === undefined
        ? "Auto-compaction is paused until context drops below the threshold."
        : "The last compaction failed. The plugin will retry after its backoff.",
    )
  } else {
    lines.push("Auto-compaction is armed.")
  }

  if (stored.threshold !== undefined) {
    lines.push(
      `Plugin config: ${formatTokens(configThreshold)} tokens. Run /autocompact auto to restore it.`,
    )
  }

  return lines.join("\n")
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    const configThreshold = parseTokenCount(ctx.options.threshold, DEFAULT_THRESHOLD)
    const configEnabled = ctx.options.enabled !== false

    let stored: StoredSettings = {}
    try {
      stored = readStoredSettings(await ctx.storage.get(SETTINGS_KEY))
    } catch (error) {
      console.error("[autocompact] could not read saved settings:", error)
    }

    const controller = new AutoCompactController({
      threshold: stored.threshold ?? configThreshold,
      enabled: configEnabled,
      retryAfterMs: retryAfter(ctx.options.retryAfterMs),
    })

    const persist = async () => {
      try {
        if (stored.threshold === undefined) {
          await ctx.storage.remove(SETTINGS_KEY)
        } else {
          await ctx.storage.set(SETTINGS_KEY, { ...stored })
        }
      } catch (error) {
        console.error("[autocompact] could not save settings:", error)
      }
    }

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

    const thresholdWarning = (threshold: number, window: number | undefined): string | undefined => {
      if (window === undefined || threshold < window) return undefined
      return (
        `Warning: this model's context window is ${formatTokens(window)} tokens, ` +
        `so a ${formatTokens(threshold)}-token threshold will never be reached. ` +
        `Lower the threshold or switch to a model with a larger window.`
      )
    }

    const requestCompaction = async (sessionID: string, observed: number): Promise<boolean> => {
      controller.requested(sessionID)
      try {
        await ctx.session.compact({ sessionID })
        console.log(
          `[autocompact] requested compaction for ${sessionID} at ${formatTokens(observed)} tokens (threshold ${formatTokens(controller.threshold)})`,
        )
        return true
      } catch (error) {
        controller.compactionFailed(sessionID, Date.now())
        console.error(`[autocompact] compaction request failed for ${sessionID}:`, error)
        return false
      }
    }

    const observeContext = async (sessionID: string): Promise<{ tokens: number; requested: boolean }> => {
      const tokens = await readContext(sessionID)
      controller.note(sessionID, tokens)
      const requested = controller.observe(sessionID, tokens, Date.now())
        ? await requestCompaction(sessionID, tokens)
        : false
      return { tokens, requested }
    }

    const statusFor = async (sessionID: string): Promise<string> => {
      const [tokens, window] = await Promise.all([readContext(sessionID), modelWindow(sessionID)])
      controller.note(sessionID, tokens)
      const snapshot = controller.snapshot(sessionID)
      const lines = [describe(snapshot, configThreshold, stored)]
      if (window !== undefined) {
        lines.push(`Model context window: ${formatTokens(window)} tokens.`)
        if (snapshot.enabled && snapshot.threshold < window) {
          lines.push(`UI context limit: ${formatTokens(snapshot.threshold)} tokens (autocompact threshold).`)
        }
      }
      const warning = thresholdWarning(snapshot.threshold, window)
      if (warning) lines.push(warning)
      return lines.join("\n")
    }

    const getContextFor = async (sessionID: string): Promise<number> => {
      const tokens = await readContext(sessionID)
      controller.note(sessionID, tokens)
      return tokens
    }

    const setThresholdFor = async (sessionID: string, tokens: number): Promise<string> => {
      if (tokens < MIN_COMMAND_THRESHOLD) {
        return `Threshold must be at least ${formatTokens(MIN_COMMAND_THRESHOLD)} tokens. ${USAGE}`
      }

      controller.setThreshold(tokens)
      stored = { ...stored, threshold: tokens }
      await persist()

      const [current, window] = await Promise.all([getContextFor(sessionID), modelWindow(sessionID)])
      const requested = controller.observe(sessionID, current, Date.now())
        ? await requestCompaction(sessionID, current)
        : false

      const lines = [
        `Autocompact threshold set to ${formatTokens(tokens)} tokens.`,
        `Current context: ${formatTokens(current)} tokens (${((current / tokens) * 100).toFixed(1)}%).`,
        requested
          ? "Compaction requested; it runs at the next step boundary."
          : "Auto-compaction is armed.",
      ]
      const warning = thresholdWarning(tokens, window)
      if (warning) lines.push(warning)
      return lines.join("\n")
    }

    const resetThresholdFor = async (sessionID: string): Promise<string> => {
      delete stored.threshold
      await persist()
      controller.setThreshold(configThreshold)

      const [current, window] = await Promise.all([getContextFor(sessionID), modelWindow(sessionID)])
      const requested = controller.observe(sessionID, current, Date.now())
        ? await requestCompaction(sessionID, current)
        : false

      const lines = [
        `Autocompact threshold reset to plugin config: ${formatTokens(configThreshold)} tokens.`,
        `Current context: ${formatTokens(current)} tokens (${((current / configThreshold) * 100).toFixed(1)}%).`,
        requested
          ? "Compaction requested; it runs at the next step boundary."
          : "Auto-compaction is armed.",
      ]
      const warning = thresholdWarning(configThreshold, window)
      if (warning) lines.push(warning)
      return lines.join("\n")
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
    ): Promise<string> => {
      switch (action) {
        case "status":
          return statusFor(sessionID)
        case "compact":
          return compactNow(sessionID)
        case "auto":
          return resetThresholdFor(sessionID)
        case "set": {
          const tokens =
            typeof argument === "number"
              ? Math.floor(argument)
              : parseCommandTokenCount(String(argument ?? ""))
          if (tokens === undefined) {
            return `Could not read a token count from "${String(argument ?? "")}". ${USAGE}`
          }
          return setThresholdFor(sessionID, tokens)
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
            "session.compaction.started",
            "session.compaction.ended",
            "session.compaction.failed",
            "session.deleted",
          ],
        })) {
          switch (event.type) {
            case "session.step.ended": {
              const sessionID = message(event)
              const tokens = contextTokens(event.data.tokens)
              if (controller.observe(sessionID, tokens, Date.now())) {
                await requestCompaction(sessionID, tokens)
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

    await ctx.command.transform((editor) => {
      editor.add({
        name: "autocompact",
        description: "Show or set when OpenCode compacts automatically (default 500k tokens)",
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
          "Use action=status to see the current context size against the threshold, action=compact to request compaction now, action=set with tokens to change the threshold, " +
          "action=auto to restore the plugin config.",
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
