export type TokenUsage = {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: {
    readonly read?: number
    readonly write?: number
  }
}

export type TokenMessage = {
  readonly type: string
  readonly tokens?: TokenUsage
}

export type AutoCompactSettings = {
  /** Compact once the conversation reaches this many tokens. */
  readonly threshold: number
  readonly enabled?: boolean
  /** Wait this long after a failed compaction before trying again. */
  readonly retryAfterMs?: number
}

export type SessionSnapshot = {
  readonly tokens: number
  readonly threshold: number
  readonly percent: number
  readonly enabled: boolean
  readonly armed: boolean
  readonly pending: boolean
  readonly failedAt?: number
}

type SessionState = {
  tokens: number
  armed: boolean
  pending: boolean
  threshold?: number
  failedAt?: number
}

const DEFAULT_RETRY_AFTER_MS = 5 * 60_000
const TOKEN_PATTERN = /^(\d+(?:\.\d+)?)\s*([km])?$/i

export type AutoCompactAction = "status" | "compact" | "set" | "auto"

export type AutoCompactCommand = {
  readonly action: AutoCompactAction
  readonly argument?: string
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * OpenCode reports usage per assistant step. Summing every bucket approximates
 * the size of the conversation that produced that step.
 */
export function contextTokens(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0
  return (
    count(tokens.input) +
    count(tokens.output) +
    count(tokens.reasoning) +
    count(tokens.cache?.read) +
    count(tokens.cache?.write)
  )
}

/** The newest assistant message with usage describes the live context. */
export function latestContextTokens(messages: readonly TokenMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === "assistant" && message.tokens) return contextTokens(message.tokens)
  }
  return 0
}

/** Accepts 500000, "500000", "500k", or "1m". */
export function parseTokenCount(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === "string") {
    const match = TOKEN_PATTERN.exec(value.trim())
    if (match) {
      const amount = Number(match[1])
      const unit = match[2]?.toLowerCase()
      const scale = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1
      const parsed = Math.floor(amount * scale)
      if (parsed > 0) return parsed
    }
  }
  return fallback
}

/**
 * Parses the size argument of `/autocompact`. Follows Claude Code's command
 * rules: `500k` and `1M` work, and a bare 100-1000 means thousands, so `500`
 * is 500,000 tokens. Unlike the config value, this returns undefined for
 * something it cannot read.
 */
export function parseCommandTokenCount(value: string): number | undefined {
  const match = TOKEN_PATTERN.exec(value.trim())
  if (!match) return undefined

  let amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  if (!unit && Number.isInteger(amount) && amount >= 100 && amount <= 1000) {
    amount *= 1_000
  }
  const scale = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1
  const tokens = Math.floor(amount * scale)
  return tokens > 0 ? tokens : undefined
}

/** Reads the first word of `/autocompact`; anything else is a size argument. */
export function parseAutocompactCommand(value: string): AutoCompactCommand {
  const trimmed = value.trim()
  if (!trimmed) return { action: "status" }

  const [head = "", ...rest] = trimmed.split(/\s+/)
  const argument = rest.join(" ")
  switch (head.toLowerCase()) {
    case "status":
      return { action: "status" }
    case "compact":
      return { action: "compact" }
    case "auto":
    case "default":
    case "reset":
      return { action: "auto" }
    default:
      return { action: "set", argument: trimmed }
  }
}

/**
 * Decides when a session should be compacted. It is deliberately small so the
 * plugin's event wiring stays boring and the anti-loop behavior is testable.
 */
export class AutoCompactController {
  readonly retryAfterMs: number

  private thresholdValue: number
  private enabledValue: boolean
  private readonly sessions = new Map<string, SessionState>()

  constructor(settings: AutoCompactSettings) {
    this.thresholdValue = Math.max(1, Math.floor(settings.threshold))
    this.enabledValue = settings.enabled ?? true
    this.retryAfterMs = Math.max(0, settings.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)
  }

  get threshold(): number {
    return this.thresholdValue
  }

  get enabled(): boolean {
    return this.enabledValue
  }

  /**
   * Set the effective threshold for one session. Re-arms only when the value
   * actually changes, so re-resolving the same threshold on every step does not
   * defeat the anti-loop pause after a compaction.
   */
  setSessionThreshold(sessionID: string, threshold: number | undefined): void {
    const session = this.session(sessionID)
    const next = threshold === undefined ? this.thresholdValue : Math.max(1, Math.floor(threshold))
    if (this.thresholdFor(sessionID) === next) return

    if (threshold === undefined) delete session.threshold
    else session.threshold = Math.max(1, Math.floor(threshold))

    if (session.pending) return
    session.armed = true
    session.failedAt = undefined
  }

  /** The threshold this session currently uses. */
  thresholdFor(sessionID: string): number {
    return this.sessions.get(sessionID)?.threshold ?? this.thresholdValue
  }

  /**
   * Record the observed context size and return true when compaction should be
   * requested. A session triggers once per crossing: it re-arms only after its
   * context drops below the threshold, or after a failed compaction's backoff.
   */
  observe(sessionID: string, tokens: number, now: number): boolean {
    const session = this.session(sessionID)
    const next = Math.max(0, Math.floor(tokens))
    session.tokens = next

    if (!this.enabled) return false

    if (next < this.thresholdFor(sessionID)) {
      session.armed = true
      session.failedAt = undefined
      return false
    }

    if (session.pending) return false

    if (!session.armed) {
      if (session.failedAt === undefined) return false
      if (now - session.failedAt < this.retryAfterMs) return false
      session.armed = true
      session.failedAt = undefined
    }

    session.armed = false
    return true
  }

  /** Record a context size without asking for a compaction. */
  note(sessionID: string, tokens: number): void {
    const session = this.session(sessionID)
    session.tokens = Math.max(0, Math.floor(tokens))
    if (session.tokens < this.thresholdFor(sessionID)) {
      session.armed = true
      session.failedAt = undefined
    }
  }

  /** Mark that a compaction request was accepted. */
  requested(sessionID: string): void {
    const session = this.session(sessionID)
    session.pending = true
    session.armed = false
    session.failedAt = undefined
  }

  compactionStarted(sessionID: string): void {
    const session = this.session(sessionID)
    session.pending = true
    session.armed = false
  }

  compactionEnded(sessionID: string): void {
    const session = this.session(sessionID)
    session.pending = false
    session.armed = false
    session.failedAt = undefined
  }

  compactionFailed(sessionID: string, now: number): void {
    const session = this.session(sessionID)
    session.pending = false
    session.armed = false
    session.failedAt = now
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  snapshot(sessionID: string): SessionSnapshot {
    const session = this.session(sessionID)
    const threshold = this.thresholdFor(sessionID)
    return {
      tokens: session.tokens,
      threshold,
      percent: session.tokens / threshold,
      enabled: this.enabled,
      armed: session.armed,
      pending: session.pending,
      failedAt: session.failedAt,
    }
  }

  private session(sessionID: string): SessionState {
    let session = this.sessions.get(sessionID)
    if (!session) {
      session = { tokens: 0, armed: true, pending: false }
      this.sessions.set(sessionID, session)
    }
    return session
  }
}
