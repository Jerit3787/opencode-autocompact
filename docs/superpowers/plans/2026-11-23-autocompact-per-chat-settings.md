# Autocompact Per-Chat Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make autocompact thresholds resolve per chat, then per project, then globally, with a desktop Settings page and a per-chat composer pill.

**Architecture:** Chat overrides live in session metadata. Global and project values live in one shared JSON file read by every server plugin instance. A small RPC lets the GUI read/write that file and session overrides. The GUI adds a Settings page and a composer pill; the built-in context ring keeps the model's real window.

**Tech Stack:** TypeScript, Bun/Node server plugin, Vitest, SolidJS GUI plugin, Vite, `@opencode/plugin` 2.3.2.

**Spec:** `docs/superpowers/specs/2026-11-23-autocompact-per-chat-settings-design.md`

## Global Constraints

- Plugin directory: `/Users/danishhakim/Documents/Default Project/opencode-autocompact`.
- Server plugin id stays `autocompact`; GUI id is the same.
- Minimum threshold is `100_000`; no upper clamp.
- Precedence is always **chat → project → global → plugin config**.
- Chat override key is `session.metadata.autocompact.threshold`; preserve all other metadata keys.
- Settings file: `~/.config/opencode/autocompact.json`; project keys are canonical project directories.
- Settings reads are cached by `mtimeMs` + size, checked at most once per second; writes are atomic (`temp` + `rename`) and serialized in-process.
- The settings store, cache, and write queue are a process-global singleton keyed by file path.
- Unit tests must never touch the real settings file; use `mkdtemp` and the `settingsPath` plugin option.
- Do not cap `model.limit.context`; the built-in ring must show the real model window.
- Keep `compaction.auto: false` and `compaction.background: false`; leave `compaction.buffer` at its default. A zero buffer collapses the compaction summary's output budget to the 1,024-token floor, so the buffer must stay positive.
- Command surface: `/autocompact`, `/autocompact <tokens>`, `/autocompact auto`, `/autocompact compact`. No `on`/`off`.
- Threshold changes re-arm only; they never compact an idle chat. `/autocompact compact` is the explicit immediate request.
- GUI entry must be a prebuilt CommonJS file at `dist/gui-experimental.cjs`; commit it because the desktop app loads it directly.
- Use the desktop CLI:
  ```sh
  OC="/Users/danishhakim/Library/Application Support/ai.opencode.desktop/cli/2.3.2-arm64/opencode-cli"
  ```
- Commit after every task. The plugin directory may not be a git repository; Task 0 initializes one if needed.

## Review Focus

- **Corrupt or partially written settings JSON** must fall back to defaults, log, and not overwrite the file. Test in Task 2.
- **Session metadata with unrelated keys** must be preserved when setting/clearing the chat override. Test in Task 1.
- **A threshold lowered below a disarmed session's context** must re-arm it and trigger on the next observation, not loop. Test in Task 3.
- **A settings file changed by another process** must be picked up by mtime, not a stale cache. Test in Task 2.
- **An RPC call arriving at the wrong project-location plugin instance** must use the directory in the request, not `ctx.location`. Test the directory resolver in Task 6 and verify with two projects in Task 10.

---

## Task 0: Repository baseline

**Files:**
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a git repository for task commits.

- [ ] **Step 1: Check whether the directory is already a git repository**

Run: `git rev-parse --is-inside-work-tree`
Expected: `true` (skip to Task 1) or an error/false (continue).

- [ ] **Step 2: Initialize the repository and ignore dependencies**

```bash
cd "/Users/danishhakim/Documents/Default Project/opencode-autocompact"
git init
printf 'node_modules/\n.DS_Store\n*.tmp\n' > .gitignore
```

Do not ignore `dist/`; the GUI bundle is a required artifact.

- [ ] **Step 3: Commit the existing baseline**

```bash
git add .
git commit -m "chore: baseline autocompact plugin"
```

---

## Task 1: Settings model, validation, and session metadata

**Files:**
- Create: `src/settings.ts`
- Create: `src/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
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
  export function isValidThreshold(value: unknown): value is number
  export function parseSettings(value: unknown, fallback: number): SettingsData
  export function resolveThreshold(input: {
    config: number
    global?: number
    project?: number | null
    session?: number | null
  }): EffectiveThreshold
  export function readSessionOverride(metadata: unknown): number | null
  export function withSessionOverride(metadata: unknown, threshold: number | null): Record<string, unknown>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest"
import {
  MIN_THRESHOLD,
  isValidThreshold,
  parseSettings,
  readSessionOverride,
  resolveThreshold,
  withSessionOverride,
} from "./settings"

describe("isValidThreshold", () => {
  it("accepts integers at or above the minimum", () => {
    expect(isValidThreshold(MIN_THRESHOLD)).toBe(true)
    expect(isValidThreshold(500_000)).toBe(true)
  })

  it("rejects lower, fractional, and non-numeric values", () => {
    expect(isValidThreshold(99_999)).toBe(false)
    expect(isValidThreshold(100_000.5)).toBe(false)
    expect(isValidThreshold("500000")).toBe(false)
    expect(isValidThreshold(undefined)).toBe(false)
  })
})

describe("parseSettings", () => {
  it("keeps valid global and project values", () => {
    expect(
      parseSettings(
        {
          version: 1,
          global: { threshold: 700_000 },
          projects: { "/a": { threshold: 300_000 }, "/bad": { threshold: 10 } },
        },
        500_000,
      ),
    ).toEqual({
      version: 1,
      global: { threshold: 700_000 },
      projects: { "/a": { threshold: 300_000 } },
    })
  })

  it("falls back to an empty settings object", () => {
    expect(parseSettings(undefined, 500_000)).toEqual({
      version: 1,
      global: {},
      projects: {},
    })
    expect(parseSettings({ global: { threshold: "x" } }, 500_000)).toEqual({
      version: 1,
      global: {},
      projects: {},
    })
  })
})

describe("resolveThreshold", () => {
  it("prefers chat, then project, then global, then config", () => {
    expect(
      resolveThreshold({ config: 500_000, global: 600_000, project: 700_000, session: 800_000 }),
    ).toEqual({
      threshold: 800_000,
      source: "chat",
      global: 600_000,
      project: 700_000,
      session: 800_000,
    })

    expect(resolveThreshold({ config: 500_000, global: 600_000, project: 700_000 })).toMatchObject({
      threshold: 700_000,
      source: "project",
    })
    expect(resolveThreshold({ config: 500_000, global: 600_000 })).toMatchObject({
      threshold: 600_000,
      source: "global",
    })
    expect(resolveThreshold({ config: 500_000 })).toEqual({
      threshold: 500_000,
      source: "config",
      global: 500_000,
      project: null,
      session: null,
    })
  })

  it("ignores invalid overrides", () => {
    expect(
      resolveThreshold({ config: 500_000, global: 10, project: 20, session: 30 }),
    ).toMatchObject({ threshold: 500_000, source: "config" })
  })
})

describe("session metadata", () => {
  it("reads and merges the chat override without dropping other keys", () => {
    const metadata = withSessionOverride({ title: "keep", other: { a: 1 } }, 700_000)
    expect(metadata).toEqual({
      title: "keep",
      other: { a: 1 },
      autocompact: { threshold: 700_000 },
    })
    expect(readSessionOverride(metadata)).toBe(700_000)
  })

  it("clears only the autocompact key", () => {
    const metadata = withSessionOverride(
      { title: "keep", autocompact: { threshold: 700_000 } },
      null,
    )
    expect(metadata).toEqual({ title: "keep" })
    expect(readSessionOverride(metadata)).toBeNull()
  })

  it("tolerates missing or malformed metadata", () => {
    expect(readSessionOverride(undefined)).toBeNull()
    expect(readSessionOverride({ autocompact: { threshold: "x" } })).toBeNull()
    expect(withSessionOverride(undefined, 700_000)).toEqual({
      autocompact: { threshold: 700_000 },
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/settings.test.ts`
Expected: FAIL because `./settings` does not exist.

- [ ] **Step 3: Implement `src/settings.ts`**

Implement the exported types and functions above.

- `isValidThreshold` only accepts finite integers `>= MIN_THRESHOLD`.
- `parseSettings` accepts an unknown value, keeps only valid thresholds, and returns `{ version: 1, global: {}, projects: {} }` for missing or malformed input.
- `resolveThreshold` chooses the first valid value in chat/project/global/config order; `global` is the resolved global-or-config value; invalid overrides become `null`.
- `readSessionOverride` reads `metadata.autocompact.threshold`; invalid values are `null`.
- `withSessionOverride` copies metadata, preserves unrelated keys, deletes `autocompact` when the threshold is `null`, and merges other `autocompact` keys when setting a value.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/settings.test.ts
git commit -m "feat: add autocompact settings model and session overrides"
```

---

## Task 2: Settings file store

**Files:**
- Create: `src/store.ts`
- Create: `src/store.test.ts`

**Interfaces:**
- Consumes: `parseSettings`, `resolveThreshold`, `EffectiveThreshold`, `SettingsData` from `./settings`.
- Produces:
  ```ts
  export type SettingsStoreOptions = {
    path: string
    configThreshold: number
    now?: () => number
  }
  export type SettingsStore = {
    read(force?: boolean): Promise<SettingsData>
    resolve(input: { directory?: string; session?: number | null; force?: boolean }): Promise<EffectiveThreshold>
    getProject(directory: string): Promise<number | null>
    setGlobal(threshold: number): Promise<SettingsData>
    setProject(directory: string, threshold: number | null): Promise<SettingsData>
  }
  export function defaultSettingsPath(): string
  export function getSettingsStore(options: SettingsStoreOptions): SettingsStore
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getSettingsStore } from "./store"

const dirs: string[] = []

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "autocompact-store-"))
  dirs.push(dir)
  let clock = 1_000
  const file = path.join(dir, "autocompact.json")
  const store = getSettingsStore({ path: file, configThreshold: 500_000, now: () => clock })
  return {
    dir,
    file,
    store,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("SettingsStore", () => {
  it("uses the config fallback when the file is missing", async () => {
    const { store } = await tempStore()
    await expect(store.resolve({ directory: "/a" })).resolves.toEqual({
      threshold: 500_000,
      source: "config",
      global: 500_000,
      project: null,
      session: null,
    })
  })

  it("writes and resolves global and project values", async () => {
    const { store } = await tempStore()
    await store.setGlobal(700_000)
    await store.setProject("/a", 300_000)

    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 300_000,
      source: "project",
    })
    await expect(store.resolve({ directory: "/b" })).resolves.toMatchObject({
      threshold: 700_000,
      source: "global",
    })
    await expect(store.resolve({ directory: "/a", session: 800_000 })).resolves.toMatchObject({
      threshold: 800_000,
      source: "chat",
    })
  })

  it("clears a project override back to the global value", async () => {
    const { store } = await tempStore()
    await store.setGlobal(600_000)
    await store.setProject("/a", 300_000)
    await store.setProject("/a", null)
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 600_000,
      source: "global",
    })
  })

  it("falls back and does not overwrite a corrupt file", async () => {
    const { file, store } = await tempStore()
    await writeFile(file, "{not json", "utf8")
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 500_000,
      source: "config",
    })
    await expect(readFile(file, "utf8")).resolves.toBe("{not json")
  })

  it("picks up an external file change after the mtime throttle", async () => {
    const { file, store, advance } = await tempStore()
    await store.setGlobal(600_000)
    await writeFile(
      file,
      JSON.stringify({ version: 1, global: { threshold: 800_000 }, projects: {} }),
      "utf8",
    )
    advance(1_001)
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 800_000,
      source: "global",
    })
  })

  it("serializes concurrent writes and leaves no temp files", async () => {
    const { dir, store } = await tempStore()
    await Promise.all([store.setGlobal(600_000), store.setProject("/a", 700_000)])
    await expect(store.resolve({ directory: "/a" })).resolves.toMatchObject({
      threshold: 700_000,
      source: "project",
    })
    const entries = await readdir(dir)
    expect(entries).toEqual(["autocompact.json"])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL because `./store` does not exist.

- [ ] **Step 3: Implement `src/store.ts`**

Implementation requirements:

- `defaultSettingsPath()` returns `path.join(os.homedir(), ".config", "opencode", "autocompact.json")`.
- `getSettingsStore(options)` returns a process-global singleton keyed by `options.path`. Use a `Symbol.for("opencode-autocompact.settings")` property on `globalThis` holding a `Map<string, SettingsStore>` so every per-location plugin instance in one server process shares it.
- `read(force = false)`:
  - Return the cached value when `force` is false and less than 1,000 ms has passed since the last check.
  - `stat` the file; on `ENOENT`, cache `parseSettings(undefined, configThreshold)`.
  - If `mtimeMs` and `size` match the cache, refresh the check timestamp and return the cache.
  - Otherwise read, JSON-parse, parse with `parseSettings(value, configThreshold)`, cache it and its stat, and return it.
  - On read/parse failure, log a warning, cache the fallback, and leave the file untouched.
- `setGlobal` / `setProject` run through a `#queue` promise chain: `read(true)`, apply only the requested field, write atomically, update the cache, return the new data.
  - `setProject(directory, null)` deletes the project entry.
  - `mkdir(dirname, { recursive: true })` before writing.
  - Write `${path}.${process.pid}.${Date.now()}.tmp`, then `rename` over the target.
- `resolve({ directory, session, force })` reads (respecting `force`) and calls `resolveThreshold` with `configThreshold`, `global.threshold`, the project entry, and `session`.
- `getProject(directory)` returns the valid project threshold or `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: add shared autocompact settings file store"
```

---

## Task 3: Per-session controller thresholds

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/engine.test.ts`

**Interfaces:**
- Consumes: existing `AutoCompactController`.
- Produces:
  ```ts
  setSessionThreshold(sessionID: string, threshold: number | undefined): void
  thresholdFor(sessionID: string): number
  ```
  `observe()` and `snapshot()` use `thresholdFor(sessionID)`.

- [ ] **Step 1: Add the failing tests to `src/engine.test.ts`**

```ts
it("uses a different threshold per session", () => {
  const controller = new AutoCompactController({ threshold: 100 })
  controller.setSessionThreshold("ses_a", 150)
  controller.setSessionThreshold("ses_b", 50)

  expect(controller.thresholdFor("ses_a")).toBe(150)
  expect(controller.observe("ses_a", 150, 0)).toBe(true)
  expect(controller.observe("ses_b", 100, 0)).toBe(false)
})

it("re-arms when the threshold moves", () => {
  const controller = new AutoCompactController({ threshold: 100 })
  expect(controller.observe("ses_1", 120, 0)).toBe(true)
  controller.requested("ses_1")
  controller.compactionEnded("ses_1")
  expect(controller.observe("ses_1", 110, 1)).toBe(false)

  controller.setSessionThreshold("ses_1", 80)
  expect(controller.observe("ses_1", 120, 2)).toBe(true)
})

it("does not re-arm when the effective threshold is unchanged", () => {
  const controller = new AutoCompactController({ threshold: 100 })
  expect(controller.observe("ses_1", 120, 0)).toBe(true)
  controller.requested("ses_1")
  controller.compactionEnded("ses_1")

  // Every step re-resolves the threshold; an unchanged value must not defeat
  // the anti-loop pause after a compaction that left context above the line.
  controller.setSessionThreshold("ses_1", 100)
  expect(controller.observe("ses_1", 130, 1)).toBe(false)
})

it("falls back to the default after clearing an override", () => {
  const controller = new AutoCompactController({ threshold: 100 })
  controller.setSessionThreshold("ses_1", 50)
  expect(controller.thresholdFor("ses_1")).toBe(50)
  controller.setSessionThreshold("ses_1", undefined)
  expect(controller.thresholdFor("ses_1")).toBe(100)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/engine.test.ts`
Expected: FAIL because `setSessionThreshold` and `thresholdFor` do not exist.

- [ ] **Step 3: Implement per-session thresholds in `src/engine.ts`**

- Add `threshold?: number` to the private `SessionState`.
- Add `setSessionThreshold(sessionID, threshold)`. Compare the new effective value with `thresholdFor(sessionID)` first: if it is unchanged, return without touching `armed` or `failedAt`. If it changed, set/delete the override and re-arm (`armed = true`, `failedAt = undefined`) unless the session is pending. Do not trigger compaction.
- Add `thresholdFor(sessionID)`: the session override or the controller default.
- Change `observe`, `note`, and `snapshot` to use `thresholdFor(sessionID)`.
- Keep `setThreshold` as the default-threshold setter; it must re-arm sessions without overrides.
- The default `threshold` getter stays.
- The no-op-on-unchanged rule is required because the plugin re-resolves the threshold on every step; without it, the anti-loop pause after a compaction that left context above the line would be defeated.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (existing tests may need the default-threshold expectations adjusted).

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat: support per-session autocompact thresholds"
```

---

## Task 4: Status formatting

**Files:**
- Create: `src/status.ts`
- Create: `src/status.test.ts`

**Interfaces:**
- Consumes: `ThresholdSource` from `./settings`.
- Produces:
  ```ts
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
  export function formatStatus(input: StatusInput): string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest"
import { formatStatus } from "./status"

const base = {
  threshold: 500_000,
  source: "chat" as const,
  tokens: 321_136,
  modelWindow: 1_000_000,
  enabled: true,
  pending: false,
  armed: true,
  configThreshold: 500_000,
  global: 500_000,
  project: null,
  session: 500_000,
}

describe("formatStatus", () => {
  it("reports the effective threshold and source", () => {
    const text = formatStatus(base)
    expect(text).toContain("Autocompact threshold: 500,000 tokens (chat)")
    expect(text).toContain("Current context: 321,136 tokens (64.2%)")
    expect(text).toContain("Auto-compaction is armed.")
    expect(text).toContain("Model context window: 1,000,000 tokens.")
  })

  it("warns when the threshold is at or above the model window", () => {
    const text = formatStatus({ ...base, threshold: 1_000_000, session: 1_000_000 })
    expect(text).toContain("will never be reached")
  })

  it("reports pending, paused, failed, and disabled states", () => {
    expect(formatStatus({ ...base, pending: true })).toContain("pending")
    expect(formatStatus({ ...base, tokens: 600_000, armed: false })).toContain("paused")
    expect(formatStatus({ ...base, tokens: 600_000, armed: true })).toContain("armed")
    expect(formatStatus({ ...base, failedAt: 1 })).toContain("failed")
    expect(formatStatus({ ...base, enabled: false })).toContain("disabled")
  })

  it("shows the project and global fallbacks when overridden", () => {
    const text = formatStatus({
      ...base,
      source: "chat",
      global: 600_000,
      project: 700_000,
      session: 800_000,
      threshold: 800_000,
    })
    expect(text).toContain("Global default: 600,000 tokens.")
    expect(text).toContain("Project override: 700,000 tokens.")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/status.test.ts`
Expected: FAIL because `./status` does not exist.

- [ ] **Step 3: Implement `src/status.ts`**

Move the existing `describe` logic out of `index.ts`:

- Always start with `Autocompact threshold: <n> tokens (<source>)`.
- Always include `Current context: <n> tokens (<percent>%)`.
- State line order: disabled; pending; failed (`failedAt` set); paused when
  `tokens >= threshold && !armed`; otherwise armed. A session at or above the
  threshold with `armed: true` is about to compact at the next step, so it
  reports armed, not paused.
- Include `Model context window: <n> tokens.` when known.
- Include `Global default: <n> tokens.` when `global !== configThreshold` or `source` is `project`/`chat`.
- Include `Project override: <n> tokens.` when non-null and `source` is `chat`.
- Include the existing warning text when `threshold >= modelWindow`.
- Percent is `tokens / threshold * 100`, one decimal.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status.ts src/status.test.ts
git commit -m "feat: format autocompact status with source and fallbacks"
```

---

## Task 5: Server wiring, command/tool, migration, remove model cap

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `getSettingsStore`, `defaultSettingsPath`, `readSessionOverride`, `withSessionOverride`, `formatStatus`, `AutoCompactController.setSessionThreshold`.
- Produces: an internal `applySessionThreshold(sessionID): Promise<EffectiveThreshold>`; the command/tool behavior below.

- [ ] **Step 1: Remove the model-limit cap**

- Delete the `realWindows` map, the `ctx.model.transform` block, and `refreshModelLimits`.
- `modelWindow(sessionID)` reads `ctx.model.list()` and returns the real `model.limit.context`.
- Verify `src/index.ts` no longer contains `limit.context =` or `Math.min(real, controller.threshold)`.

- [ ] **Step 2: Wire the settings store and migration**

At setup:

```ts
const configThreshold = parseTokenCount(ctx.options.threshold, DEFAULT_THRESHOLD)
const configEnabled = ctx.options.enabled !== false
const settingsPath =
  typeof ctx.options.settingsPath === "string" && ctx.options.settingsPath.length > 0
    ? ctx.options.settingsPath
    : defaultSettingsPath()
const store = getSettingsStore({ path: settingsPath, configThreshold })
```

Migrate the old per-location storage once:

```ts
const canonical = String(ctx.location.project.canonical)
const legacy = await ctx.storage.get("settings")
if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
  const raw = (legacy as Record<string, unknown>).threshold
  if (typeof raw === "number" && raw > 0 && (await store.getProject(canonical)) === null) {
    await store.setProject(canonical, Math.floor(raw))
  }
}
await ctx.storage.remove("settings")
```

Wrap migration in `try/catch` and log a warning on failure. Remove the old `persist`, `readStoredSettings`, `stored`, and `SETTINGS_KEY` usage.

- [ ] **Step 3: Add effective-threshold resolution**

```ts
const applySessionThreshold = async (
  sessionID: string,
  directory = String(ctx.location.project.canonical),
) => {
  const session = await ctx.session.get({ sessionID })
  const override = readSessionOverride(session.metadata)
  const resolved = await store.resolve({ directory, session: override })
  controller.setSessionThreshold(sessionID, resolved.threshold)
  return resolved
}
```

- On `session.step.ended`: call `applySessionThreshold(sessionID)` before `contextTokens`/`observe`. The controller's no-op-on-unchanged rule keeps this from defeating the anti-loop pause after a compaction.
- Add `session.metadata.updated` to the subscription; call `applySessionThreshold(message(event))` (catch and log errors).
- Keep `session.compaction.ended` note logic and `session.deleted` forget.
- RPC handlers that act on a session pass the request's `directory` to `applySessionThreshold`, not the receiving instance's location.

- [ ] **Step 4: Replace the command/tool actions**

- `statusFor(sessionID)`: `applySessionThreshold`, read context, `controller.note`, `controller.snapshot`, `modelWindow`, then `formatStatus` with the resolved source/global/project/session and `configThreshold`.
- `setThresholdFor(sessionID, tokens)`: validate `tokens >= MIN_THRESHOLD`; read the session, `withSessionOverride(session.metadata, tokens)`, `ctx.session.update({ sessionID, metadata })`, `applySessionThreshold`, return `statusFor` text. **Do not** call `requestCompaction`.
- `resetThresholdFor(sessionID)`: same with `withSessionOverride(metadata, null)`.
- `compactNow` stays as-is.
- `runAction` keeps `status`, `compact`, `set`, `auto`; no `on`/`off`.
- The tool keeps its existing chat-scoped actions; remove any settings-page/global actions.
- The command result remains a synthetic notice with `resume: false`.

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Live check**

```sh
OC="/Users/danishhakim/Library/Application Support/ai.opencode.desktop/cli/2.3.2-arm64/opencode-cli"
$OC reload
$OC api get /api/model -H "x-opencode-directory: %2FUsers%2Fdanishhakim%2FDocuments%2FDefault%20Project" \
  | node -e "let x='';process.stdin.on('data',d=>x+=d).on('end',()=>{const j=JSON.parse(x);for(const m of j.data){if(m.providerID==='opencode-go'&&m.id==='deepseek-v4.1-flash')console.log(m.limit.context)}})"
```

Expected: `1000000` (the real window; the cap is gone).

Create a temporary session, run `/autocompact 700k`, inspect the inbox and session metadata, run `/autocompact auto`, then delete the session. Expected:

- status source is `chat` after setting 700k;
- `session.metadata.autocompact.threshold` is `700000`;
- `auto` clears it and the source falls back to `config` (or project/global);
- no compaction is requested by the set operation.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/engine.ts
git commit -m "feat: resolve autocompact thresholds per chat, project, and global"
```

---

## Task 6: RPC contract and server handlers

**Files:**
- Create: `src/rpc.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `SettingsStore`, `isValidThreshold`, `readSessionOverride`, `withSessionOverride`, `ThresholdSource`.
- Produces:
  ```ts
  export type SettingsPayload = {
    global: number
    project: number | null
    session: number | null
    effective: number
    source: ThresholdSource
    enabled: boolean
  }
  export const AutocompactRpc = Rpc.define({ ... })
  export function requestDirectory(input: { directory?: string }, fallback: string): string
  ```
  RPC methods: `get`, `setGlobal`, `setProject`, `setSession`; event: `changed`.

- [ ] **Step 1: Define the contract**

Create `src/rpc.ts` with `Rpc.define` id `autocompact`. Use JSON Schema:

- `get`: input `{ directory?: string, sessionID?: string }`.
- `setGlobal`: input `{ directory?: string, sessionID?: string, threshold: number }`.
- `setProject`: input `{ directory: string, sessionID?: string, threshold: number | null }`.
- `setSession`: input `{ directory: string, sessionID: string, threshold: number | null }`.
- Each method outputs `SettingsPayload`: `global` number, `project` number|null, `session` number|null, `effective` number, `source` enum, `enabled` boolean.
- Errors: `invalid_threshold` with `{ minimum: number }`, `write_failed` with `{ message: string }`.
- Event `changed` with `{ directory?: string, sessionID?: string }`.
- Export `requestDirectory(input, fallback)`: trimmed `input.directory` or fallback.

- [ ] **Step 2: Add a failing test for the directory resolver**

Create `src/rpc.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { requestDirectory } from "./rpc"

describe("requestDirectory", () => {
  it("uses the request directory instead of the receiving instance", () => {
    expect(requestDirectory({ directory: "/project/a" }, "/project/b")).toBe("/project/a")
    expect(requestDirectory({}, "/project/b")).toBe("/project/b")
    expect(requestDirectory({ directory: "  " }, "/project/b")).toBe("/project/b")
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/rpc.test.ts`
Expected: FAIL because `./rpc` does not exist.

- [ ] **Step 4: Implement `src/rpc.ts`**

Implement the contract and `requestDirectory`. Import `Rpc` from `@opencode/plugin/rpc`.

- [ ] **Step 5: Register the RPC in `src/index.ts`**

Build a `payloadFor(input)` helper:

```ts
const payloadFor = async (input: { directory?: string; sessionID?: string }): Promise<SettingsPayload> => {
  const directory = requestDirectory(input, String(ctx.location.project.canonical))
  const session = input.sessionID ? await ctx.session.get({ sessionID: input.sessionID }) : undefined
  const override = session ? readSessionOverride(session.metadata) : null
  const resolved = await store.resolve({ directory, session: override })
  return {
    global: resolved.global,
    project: resolved.project,
    session: resolved.session,
    effective: resolved.threshold,
    source: resolved.source,
    enabled: configEnabled,
  }
}
```

Register handlers:

- `get`: `payloadFor(input)`.
- `setGlobal`: validate `isValidThreshold`; on invalid return `context.error("invalid_threshold", "Threshold must be at least 100,000 tokens", { minimum: MIN_THRESHOLD })`; `store.setGlobal`; if `input.sessionID` call `applySessionThreshold(input.sessionID, directory)`; emit `changed`; return `payloadFor(input)`.
- `setProject`: validate or `null`; `store.setProject`; if `input.sessionID` call `applySessionThreshold(input.sessionID, directory)`; emit; return `payloadFor`.
- `setSession`: validate or `null`; read the session, `withSessionOverride`, `ctx.session.update`, `applySessionThreshold(input.sessionID, input.directory)`, emit; return `payloadFor`.
- Catch write failures and return `context.error("write_failed", message, { message })`.

Keep the registration object for the plugin lifetime. After registration, expose
`registration.events.emit("changed", …)` to the command's set/auto helpers so a
chat override changed from `/autocompact` refreshes the Settings page and the
pill. The helpers run before registration, so hold the emitter in a `let`
initialized to a no-op and assign it after `ctx.rpc.register`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/rpc.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Reload and check for load errors**

Run: `"$OC" reload`
Expected: `Configuration reloaded`; the OpenCode log has no `failed to load plugin` for `autocompact`.

- [ ] **Step 8: Commit**

```bash
git add src/rpc.ts src/rpc.test.ts src/index.ts
git commit -m "feat: add autocompact settings RPC"
```

---

## Task 7: GUI build scaffolding

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/gui.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `dist/gui-experimental.cjs`, a loadable GUI plugin with the id `autocompact`.

- [ ] **Step 1: Install GUI build dependencies**

Run:

```bash
npm install -D vite vite-plugin-solid solid-js
```

- [ ] **Step 2: Update `package.json`**

Add:

```json
"exports": {
  ".": "./src/index.ts",
  "./rpc": "./src/rpc.ts",
  "./gui-experimental": "./dist/gui-experimental.cjs"
},
"files": ["src", "dist", "README.md"],
"scripts": {
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "build:gui": "vite build",
  "check": "npm run typecheck && npm test && npm run build:gui"
}
```

- [ ] **Step 3: Update `tsconfig.json`**

Add:

```json
"jsx": "preserve",
"jsxImportSource": "solid-js"
```

Keep `"include": ["src"]`.

- [ ] **Step 4: Create `vite.config.ts`**

```ts
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  plugins: [gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" })],
})
```

- [ ] **Step 5: Create the placeholder GUI entry**

`src/gui.tsx`:

```tsx
import { Plugin } from "@opencode/plugin/gui"

export default Plugin.define({
  setup() {},
})
```

- [ ] **Step 6: Build and typecheck**

Run: `npm run build:gui && npm run typecheck`
Expected: `dist/gui-experimental.cjs` exists; typecheck passes.

- [ ] **Step 7: Reload and confirm the GUI loads**

Run: `"$OC" reload`
Expected: no plugin load error; the desktop app lists the plugin. No visible UI change yet.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts src/gui.tsx dist/gui-experimental.cjs
git commit -m "build: add desktop GUI plugin bundle"
```

---

## Task 8: Settings page

**Files:**
- Create: `src/gui/state.ts`
- Create: `src/gui/settings-page.tsx`
- Modify: `src/gui.tsx`

**Interfaces:**
- Consumes: `AutocompactRpc`, `SettingsPayload`, `MIN_THRESHOLD`, `parseCommandTokenCount`.
- Produces:
  ```ts
  import type { Context } from "@opencode/plugin/gui"
  export function settingsKey(directory: string | undefined, sessionID: string | undefined): string
  export const settingsState: Record<string, SettingsPayload>
  export async function loadSettings(ctx: Context, input: { directory?: string; sessionID?: string }): Promise<SettingsPayload>
  export async function saveGlobal(ctx: Context, directory: string | undefined, sessionID: string | undefined, threshold: number): Promise<SettingsPayload>
  export async function saveProject(ctx: Context, directory: string, sessionID: string | undefined, threshold: number | null): Promise<SettingsPayload>
  export async function clearSession(ctx: Context, directory: string, sessionID: string): Promise<SettingsPayload>
  export function subscribeSettings(ctx: Context): () => void
  ```
  A module-level Solid store maps `settingsKey` → `SettingsPayload`; `settingsState` is that store proxy.

- [ ] **Step 1: Implement `src/gui/state.ts`**

- `const [settingsState, setSettingsState] = createStore<Record<string, SettingsPayload>>({})` at module scope; export `settingsState`.
- `settingsKey(directory, sessionID)` joins `directory ?? ""` and `sessionID ?? ""` with `\n`.
- `loadSettings`, `saveGlobal`, `saveProject`, `clearSession` call `ctx.client.rpc(AutocompactRpc)` and update the store with the returned payload.
- `loadSettings` dedupes in-flight requests by `settingsKey` so the pill's reactive `show` cannot start a request storm.
- Read `ctx.client` inside each function, not once at module scope.
- `subscribeSettings(ctx)` subscribes to `ctx.client.rpc(AutocompactRpc).events.on("changed", ...)` and clears the store so pills refetch; return the unsubscribe function. Wrap it in `try/catch` and return a no-op cleanup if the RPC is not available yet.
- Optional `refreshSettings(ctx, input)` alias for the pill.

- [ ] **Step 2: Implement `src/gui/settings-page.tsx`**

Export `AutocompactSettingsPage`. Use `usePlugin()` and `ctx.ui`.

- Read the routed session: `ctx.sessions.current()`.
- `directory = session?.project?.canonical ?? session?.directory`. If the
  installed `Project` type has no `canonical`, use `session.directory` for v1
  and document the worktree limitation.
- `sessionID = session?.id`.
- Load `loadSettings` on mount and whenever the routed session key changes; use `createEffect` with a keyed accessor.
- Render `ui.SettingsLayout` title "Autocompact" with three sections:
  - **Global default**: a `ui.TextInput` with value (compact string such as `500k`) and a `ui.Button` Save. Parse with `parseCommandTokenCount`; reject values below `MIN_THRESHOLD`; call `saveGlobal`.
  - **This project**: a `ui.TextInput` + Save plus a **Use global** button; call `saveProject(directory, ..., value | null)`. Disable when no session, with a note.
  - **This chat**: show effective threshold, source, and a **Reset chat override** button calling `clearSession(directory, sessionID)`. Disable when no session.
- Show a footer error on invalid input or RPC failure.
- Use getters/reactive reads for session data; do not read `ctx.sessions.current()` once in setup.

- [ ] **Step 3: Wire the page in `src/gui.tsx`**

```tsx
import { Plugin, SettingsPage } from "@opencode/plugin/gui"
import { AutocompactSettingsPage } from "./gui/settings-page"
import { subscribeSettings } from "./gui/state"

export default Plugin.define({
  i18n: {
    en: {
      "page.title": "Autocompact",
      "page.description": "Choose when OpenCode summarizes context.",
    },
  },
  setup(ctx) {
    const unsubscribe = subscribeSettings(ctx)

    ctx.add(SettingsPage, {
      id: "autocompact",
      get title() {
        return ctx.t("page.title")
      },
      icon: "status",
      render: () => <AutocompactSettingsPage />,
    })

    return () => unsubscribe()
  },
})
```

The page should read the current `settingsState[key]` (or a memo over it)
rather than keeping an isolated copy, so the `changed` event refresh is visible.

- [ ] **Step 4: Build and typecheck**

Run: `npm run build:gui && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Reload and check the page**

Run: `"$OC" reload`
Open **Settings → Autocompact**. Expected: global/project/chat sections render; global works without a session; project/chat show a note when no session is routed.

- [ ] **Step 6: Commit**

```bash
git add src/gui.tsx src/gui/state.ts src/gui/settings-page.tsx dist/gui-experimental.cjs
git commit -m "feat: add autocompact settings page"
```

---

## Task 9: Composer pill

**Files:**
- Create: `src/gui/pill.tsx`
- Modify: `src/gui.tsx`

**Interfaces:**
- Consumes: `settingsKey`, `settingsState`, `loadSettings`, `clearSession`, `readSessionOverride`, `lastAssistantWithUsage`, `MountedSession` from `@opencode/plugin/gui`, `SettingsPayload`.
- Produces:
  ```ts
  export type AutocompactPillView = {
    label: string
    tone?: "success" | "warning" | "danger"
    title?: string
    rows?: Array<{ id: string; label: string; detail?: string; run?: () => void }>
  }
  export function autocompactPillView(input: {
    session: MountedSession
    payload: SettingsPayload
    override: number | null
    onReset?: () => void
  }): AutocompactPillView | undefined
  ```

- [ ] **Step 1: Implement `src/gui/pill.tsx`**

`autocompactPillView` is a pure view builder; it does not call RPC or read plugin context.

- Compute current tokens:
  - `const messages = input.session.server.data.session.message.list(input.session.id)`
  - `const info = input.session.server.data.session.get(input.session.id)`
  - `const message = lastAssistantWithUsage(messages, info?.revert?.messageID)`
  - Sum `input + output + reasoning + cache.read + cache.write`.
- Effective = `input.override ?? input.payload.effective`; source = `input.override !== null ? "Chat" : sourceLabel(input.payload.source)`.
- `sourceLabel` maps `chat` → `Chat`, `project` → `Project`, `global` → `Global`, `config` → `Config`.
- Label: compact token strings separated by ` / `, e.g. `321k / 500k`. Use `Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 0 })`.
- Tone: `undefined` below 80%, `"warning"` at 80–89%, `"danger"` at 90%+.
- Rows:
  - `{ id: "source", label: "Source", detail: source }`
  - `{ id: "global", label: "Global", detail: format(payload.global) }`
  - `{ id: "project", label: "Project", detail: payload.project === null ? "Inherit" : format(payload.project) }`
  - When `input.override !== null && input.onReset`: `{ id: "reset", label: "Reset chat override", run: input.onReset }`
- Return `undefined` when there is no assistant usage or no positive effective threshold.
- Do not throw; catch and return `undefined`.

- [ ] **Step 2: Wire the pill in `src/gui.tsx`**

The `ComposerPill.show` callback returns the view object directly; it is not a component.

```tsx
import { ComposerPill, Plugin, SettingsPage } from "@opencode/plugin/gui"
import { autocompactPillView } from "./gui/pill"
import { clearSession, loadSettings, settingsKey, settingsState } from "./gui/state"
import { readSessionOverride } from "../settings"

ctx.add(ComposerPill, {
  id: "autocompact",
  order: 0,
  show: (input) => {
    const directory = input.session.project?.canonical ?? input.session.directory
    const key = settingsKey(directory, input.session.id)
    const payload = settingsState[key]

    if (!payload) {
      void loadSettings(ctx, { directory, sessionID: input.session.id })
      return undefined
    }

    const info = input.session.server.data.session.get(input.session.id)
    const override = readSessionOverride(info?.metadata)

    // The command can change the override without going through the RPC.
    // Refresh before rendering so an old effective value is never shown.
    if (payload.session !== override) {
      void loadSettings(ctx, { directory, sessionID: input.session.id })
      return undefined
    }

    return autocompactPillView({
      session: input.session,
      payload,
      override,
      onReset: () => void clearSession(ctx, directory, input.session.id),
    })
  },
})
```

`loadSettings` dedupes in-flight requests, so the first render returns `undefined`
and the store update rerenders the pill with a value.

If the installed `Project` type has no `canonical` field, use
`input.session.directory` for v1 and document that worktrees get their own
project entry; do not block the feature on canonicalization.

- [ ] **Step 3: Build and typecheck**

Run: `npm run build:gui && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Reload and check two chats**

Run: `"$OC" reload`
Open two chats in the same project. Set `/autocompact 700k` in one and leave the other at the default. Expected:

- Pills show different thresholds.
- The chat with the override reports source `Chat`; the other reports `Project`/`Global`/`Config`.
- The built-in header ring still measures against the real 1M window.

- [ ] **Step 5: Commit**

```bash
git add src/gui.tsx src/gui/pill.tsx dist/gui-experimental.cjs
git commit -m "feat: add per-chat autocompact composer pill"
```

---

## Task 10: README, full checks, and live acceptance

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: user documentation and verified acceptance evidence.

- [ ] **Step 1: Update `README.md`**

Document:

- Precedence: chat → project → global → plugin config.
- `/autocompact`, `/autocompact <tokens>`, `/autocompact auto`, `/autocompact compact`.
- Settings → Autocompact: global default, project override, chat status/reset.
- Per-chat composer pill.
- The built-in header ring shows the real model window; the pill is the autocompact indicator.
- `settingsPath` is a test-only option; don't set it for normal use.
- Migration from the old per-location threshold.
- `compaction.auto: false` and `background: false` remain; `buffer` stays at its default (positive).

- [ ] **Step 2: Run the full local checks**

Run:

```bash
npm run typecheck
npm test
npm run build:gui
```

Expected: all pass; `dist/gui-experimental.cjs` is rebuilt.

- [ ] **Step 3: Run the live acceptance checklist with a temp settings file**

Set `settingsPath` to a temporary path in the plugin options, reload, and verify:

- Create two temporary sessions in the current project.
- `/autocompact 700k` in session A only.
- `opencode api get /api/session/<A>` shows `metadata.autocompact.threshold = 700000`; session B does not.
- `/autocompact status` in A reports source `chat`; in B reports `config`/`global`.
- `/autocompact auto` in A clears the override and falls back.
- `opencode api get /api/model -H "x-opencode-directory: ..."` reports `context: 1000000` (the model cap is gone).
- The Settings page edits global/project values and the RPC `changed` event refreshes the pill.
- The built-in ring still shows the real model window.
- Delete both temporary sessions and remove the temporary settings file.
- Restore the plugin options by removing `settingsPath`, then reload.

Expected: every item passes; the user's real `~/.config/opencode/autocompact.json` is untouched.

- [ ] **Step 4: Commit**

```bash
git add README.md dist/gui-experimental.cjs
git commit -m "docs: describe per-chat autocompact settings"
```

---

## Self-Review Notes

- Spec coverage:
  - Chat → project → global precedence: Tasks 1, 2, 5.
  - Session metadata and clearing: Task 1, Task 5.
  - Settings file, atomic/mtime/singleton: Task 2.
  - Per-session controller: Task 3.
  - Status source output: Task 4.
  - Remove model cap and migrate old storage: Task 5.
  - RPC with directory/session addressing: Task 6.
  - GUI build: Task 7.
  - Settings page: Task 8.
  - Composer pill: Task 9.
  - Docs and acceptance: Task 10.
- Review Focus tests:
  - Corrupt file: Task 2 test.
  - Metadata merge: Task 1 test.
  - Lowered threshold re-arm: Task 3 test.
  - Cross-process mtime: Task 2 test.
  - Wrong-project RPC: Task 6 `requestDirectory` test; Task 10 two-project live check.
- Tasks 5, 6, and 7-9 are integration/GUI work with typecheck, build, reload, and manual acceptance rather than unit tests; the pure logic they depend on is covered by Tasks 1-4 and 6.
