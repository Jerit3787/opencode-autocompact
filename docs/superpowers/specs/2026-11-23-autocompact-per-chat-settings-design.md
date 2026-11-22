# Autocompact per-chat, per-project, and global settings

Date: 2026-11-23

## Intent

Make the autocompact threshold a per-chat setting, with a global default and a
per-project override, and expose those defaults in OpenCode Desktop's Settings.
The existing `/autocompact` command stays the per-chat control; a new Settings
page controls global and project values; a per-chat composer pill shows the
effective threshold and current usage.

Claude Code's auto-compact window is tied to the current model and session.
This design goes one step further: the effective value is resolved
**chat override → project override → global default → plugin config fallback**.

## Goals

- `/autocompact 700k` changes only the current chat.
- `/autocompact auto` removes the chat override; the chat falls back to its
  project or global value.
- A global default and a per-project override are editable in a desktop
  Settings page.
- New chats pick up changes without restarting the app.
- The per-chat composer pill shows `used / effective` and the source of the
  effective value.
- The built-in context ring stays honest about the model's real window.
- All existing anti-loop behavior remains: one compaction per crossing, re-arm
  after context drops below the effective threshold, retry after a failed
  compaction.

## Non-goals

- Replacing or hiding the built-in header context ring.
- Per-model thresholds (Claude's setting is model-scoped; this is chat-scoped).
- Cross-window or cross-device live sync.
- Cloud settings, multi-user, or team policy.
- Editing `opencode.jsonc` from the UI.
- An enable/disable switch in the settings page in v1; the plugin option
  `enabled: false` remains the way to disable automatic triggering.

## Anti-goals

- A single global `model.limit.context` cap that misrepresents chats with
  different thresholds.
- Per-threshold model clones to force the built-in ring to show a chat's value.
- Storing chat thresholds only in plugin storage keyed by a location, which is
  not per-chat and does not react to session changes.
- A settings page that only writes configuration files.

## Current state

- `opencode-autocompact` is a server plugin, id `autocompact`, loaded from the
  global config at `/Users/danishhakim/Documents/Default Project/opencode-autocompact`.
- `compaction.auto` and `compaction.background` are off; `compaction.buffer`
  stays at its default positive reserve; the plugin option `threshold` is
  `500000`.
- `/autocompact` currently supports `status`, `compact`, `auto`, and a token
  value. `/autocompact auto` resets to the plugin config threshold.
- The plugin currently caps every model's `limit.context` at the threshold so
  the built-in header ring shows the autocompact ceiling. That cap is global to
  the project location, so it cannot represent per-chat thresholds.
- The controller already tracks per-session state (tokens, armed, pending,
  failedAt) but has one shared threshold.
- The desktop app's built-in context indicator divides the latest assistant
  message's usage by `model.limit.context`. It is the source of the header ring
  and the Context panel's Limit/Usage stats.

## Approaches considered

### A. Session metadata + JSON settings file + GUI settings page + composer pill (chosen)

- Chat override in `session.metadata.autocompact.threshold`.
- Global and project values in `~/.config/opencode/autocompact.json`.
- Server plugin exposes an RPC; the GUI settings page and pill call it.
- The pill is the per-chat indicator; the built-in ring keeps the real model
  window.
- Pros: true per-chat values, reactive session metadata, one shared settings
  source for every server plugin instance, no config-file editing, no fragile
  model cloning.
- Cons: adds a GUI bundle/build and a small RPC contract; the built-in ring no
  longer shows the autocompact threshold.

### B. Global/project settings in OpenCode config files, settings page writes config

- Pros: one configuration source, native watcher reload.
- Cons: updating nested plugin options in `opencode.jsonc` is fragile, the
  config-update API is experimental, and the settings page must preserve
  comments and unrelated fields. Per-chat values still need session metadata.

### C. Per-threshold model clones so the built-in ring is per-chat

- Pros: the built-in ring itself shows the chat threshold.
- Cons: changes the session's model, needs provider-model ID indirection,
  creates clones per threshold, and is fragile across OpenCode updates.

**Chosen: A.** B trades one fragile write path for another and does not solve
per-chat alone; C is rejected because it changes what the session is talking to
and depends on internals.

## Design

### Settings hierarchy

Effective threshold for a session:

1. `session.metadata.autocompact.threshold`, if present.
2. Project entry for the canonical project directory, if present.
3. Global `global.threshold`, if present.
4. Plugin option `threshold` (migration/fallback default).

The source is reported as `chat`, `project`, `global`, or `config`.

### Chat override

- Stored in session metadata under the `autocompact` key:
  ```json
  { "autocompact": { "threshold": 700000 } }
  ```
- Updating preserves all other metadata keys.
- `/autocompact auto` removes the `autocompact` key (or its `threshold`), so the
  chat inherits again.
- Session deletion needs no settings-file cleanup.
- Forks that copy metadata inherit the override; that is acceptable.

### Settings file

Path: `~/.config/opencode/autocompact.json` (resolve `~` with `os.homedir()`;
on macOS this is the OpenCode config directory used by this install).

Schema:

```json
{
  "version": 1,
  "global": { "threshold": 500000 },
  "projects": {
    "/canonical/path/to/project": { "threshold": 700000 }
  }
}
```

- Missing file: use the plugin option `threshold` as the fallback global value.
- A missing `projects` entry or `{ "threshold": null }` means "inherit global".
- Invalid JSON or invalid values: log a warning, use the fallback, and do not
  overwrite the file until the user saves from Settings.
- Writes are atomic (`write temp in same directory` then `rename`) and
  serialized through a promise queue.
- Reads are cached by `mtimeMs` + size; every server plugin instance checks the
  file on demand, so an instance in another project sees a settings-page change
  without a restart.
- The project key is the canonical project directory (`ctx.location.project.canonical`
  on the server). A worktree session resolves to its project's override, not the
  worktree path.
- The settings store, its mtime cache, and its write queue are a
  process-global singleton keyed by file path, because `setup` runs once per
  project location in the same server process. All instances in one process
  share the cache and serialized writes; other processes (CLI/TUI servers) see
  changes through the file mtime.

### Server plugin changes

- Remove the model-limit transform and `realWindows` cap. Models keep their real
  `limit.context`, so the built-in ring is accurate.
- Add a settings store module:
  - `readSettings()` with mtime cache.
  - `writeSettings()` with atomic write and serialization.
  - `resolve({ sessionID, project })` returning the effective threshold and
    source.
  - Pure validation and precedence functions, unit-testable without a running
    server.
- Controller:
  - Change the shared threshold to a per-session threshold map with a default.
  - `setSessionThreshold(sessionID, value | undefined)`.
  - `observe` uses the session's effective threshold and keeps the current
    one-trigger-per-crossing behavior.
  - `snapshot` reports the session's effective threshold.
- Effective-threshold updates:
  - On `session.metadata.updated`, refresh the cached session threshold.
  - On first encounter of a session (step event or command), lazily read session
    metadata if the cache is empty.
  - On every `session.step.ended`, re-resolve the effective threshold for that
    session and update the controller before observing. The settings store
    checks the file mtime (throttled to at most once per second) so an already
    open chat picks up a global/project change on its next step, including
    chats in another window, project, or TUI/CLI process.
  - Project/global changes from the RPC update the shared in-process cache
    immediately; other processes pick up the file by mtime.
- Threshold changes never compact an idle chat by themselves. They re-arm the
  session for the new line; compaction runs at the next step boundary after
  the context is observed at or above it. Use `/autocompact compact` for an
  immediate request. Raising a threshold also re-arms, so the new line must be
  crossed again.
- The command/tool remain chat-scoped:
  - `/autocompact` or `status`: effective threshold, source, current context,
    model window, and a warning if the effective threshold is at or above the
    model window.
  - `/autocompact <tokens>`: set the chat override (minimum 100,000).
  - `/autocompact auto`: clear the chat override.
  - `/autocompact compact`: manual compaction (runs at the next step boundary).
  - The tool keeps the same actions: `status`, `compact`, `set`, `auto`.
- Remove the old per-location `ctx.storage` threshold override and its `auto`
  behavior. Migration: if the old storage key holds a threshold when the plugin
  starts and the settings file has no value for that project, write it as the
  project override once. Remove the old storage key in every case after the
  one-time check, so it cannot resurrect an old value if the project override is
  later cleared.
- Keep `compaction.auto: false` and `compaction.background: false`; leave
  `compaction.buffer` at its default. A zero buffer makes the compaction
  request measure its input at the whole window, which collapses the summary's
  output budget to the 1,024-token floor and fails the summary.

### RPC

New file `src/rpc.ts`, using `Rpc.define` from `@opencode/plugin/rpc`, id
`autocompact` (matches the plugin id). Register with `ctx.rpc.register`.

Methods:

Project and session methods take the canonical `directory` of the project the
caller is looking at; session methods also take `sessionID`. The handler must
use the provided directory rather than assuming it landed on the matching
plugin instance, because one server process hosts every project location. If
`directory` is omitted, use `ctx.location.project.canonical` only as a
same-location fallback.

- `get({ directory?: string, sessionID?: string })` →
  `{ global: number, project: number | null, session: number | null, effective: number, source: "chat" | "project" | "global" | "config", enabled: boolean }`.
  Without a directory, only the global/config values are resolved and
  `effective` equals the global value.
- `setGlobal({ directory?: string, sessionID?: string, threshold: number })` →
  the same payload as `get` for that caller. The global Settings section works
  without a routed session.
- `setProject({ directory: string, sessionID?: string, threshold: number | null })` →
  the same payload. `null` means inherit the global value.
- `setSession({ directory: string, sessionID: string, threshold: number | null })` →
  the same payload. `null` clears the chat override. The Settings page uses this
  for the chat reset control; the command calls the same internal function.

Validation: threshold is an integer ≥ 100,000; no upper clamp. Errors are
declared RPC errors (`invalid_threshold`, `not_found`, `write_failed`) so the
Settings page can show a row footer message.

Events:

- `changed` with `{ directory?: string, sessionID?: string }` after a successful
  write or chat override change. GUI subscribers refresh their cached values.
  Live-only; a window that was disconnected refetches on next mount.

The server registers the RPC in `setup`; the command/tool use the same internal
helpers, not RPC round-trips.

### GUI package

Add a desktop part to the same package:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./rpc": "./src/rpc.ts",
    "./gui-experimental": "./dist/gui-experimental.cjs"
  }
}
```

Build with the GUI Vite preset:

```ts
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({ plugins: [gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" })] })
```

Add `vite`, `vite-plugin-solid`, and `solid-js` as dev dependencies. Add
`build:gui` and include it in the normal build/check scripts. The GUI plugin id
is the server id `autocompact`, which is not reserved.

### Settings page

`ctx.add(SettingsPage, ...)` with a page of its own:

- id `autocompact`, title "Autocompact", icon `status`.
- **Global default**: a `Select` of presets (`300k`, `500k`, `700k`, `800k`,
  `1M`, `Custom`) plus a `TextInput` for custom. Save via RPC; show a footer
  error for invalid values.
- **This project**: `Use global (500k)` or a custom value. Use the routed
  session's project directory (`ctx.sessions.current()?.project?.canonical ??
  ctx.sessions.current()?.directory`). If no session is routed, show a note that
  a chat must be open to edit project settings, and keep the global section
  usable.
- **This chat**: effective threshold, source, current context, and a
  **Reset chat override** button (RPC `setSession` with `null`). Only when a
  session is routed.
- Use `ctx.ui.SettingsLayout`, `SettingsSection`, `SettingsRow`, `Select`,
  `TextInput`, `Button`, and `Switch` as appropriate. The page must react to
  session changes, not read `ctx.sessions.current()` once in setup.

### Composer pill

`ctx.add(ComposerPill, ...)` per routed session:

- Compute current tokens from the session's latest assistant usage after the
  last completed compaction, before any undo boundary, using
  `lastAssistantWithUsage` from `@opencode/client/solid`; sum
  `input + output + reasoning + cache.read + cache.write`.
- Resolve the effective threshold from session metadata first, then the cached
  RPC result for the project/global values. Refetch the RPC result on session
  change and on the RPC `changed` event.
- Label: `321k / 500k` using compact notation. Tone: default below 80%,
  `warning` at 80–89%, `danger` at 90% or above.
- Rows: the source (`Chat`, `Project`, `Global`, `Config`), the global and
  project values, and a **Reset chat override** action when a chat override
  exists.
- Hide the pill when there is no session or no effective threshold.
- The built-in header ring remains, showing the real model window. The pill is
  the per-chat autocompact indicator; no attempt is made to hide or replace the
  built-in ring in v1.

### Status text

`/autocompact` reports:

```
Autocompact threshold: 700,000 tokens (chat)
Current context: 321,136 tokens (45.9%)
Auto-compaction is armed.
Model context window: 1,000,000 tokens.
```

If the effective threshold is at or above the model window, add the existing
warning. No "UI context limit" line, because the model limit is no longer
capped.

## Error handling and edge cases

- Invalid threshold from command/tool: usage message, no state change.
- Invalid RPC threshold: `invalid_threshold` error; Settings page footer.
- Corrupt settings file: warning log; fallback values; do not overwrite until a
  save.
- Settings file write failure: `write_failed`; no in-memory update.
- RPC unavailable in the GUI: the page shows an error row; the pill hides the
  threshold rather than showing a wrong value.
- Unknown model window: show the threshold without the warning.
- Session metadata with other keys: merge, never replace the whole metadata
  object.
- A chat override above the model window: allowed, with the warning; compaction
  will not fire before the provider limit, so the warning matters.
- Project path changes/renames: the old project entry remains in the file; it is
  harmless. No automatic migration in v1.
- Multiple windows: the settings page and pill use RPC `changed` events; a
  window that missed events refetches on mount.

## Testing

Unit tests (pure, no server):

- Settings parse/validate and corrupt-file fallback.
- Precedence resolution: chat > project > global > config.
- Session metadata merge and clearing.
- Controller per-session thresholds: different chats trigger at different sizes;
  one trigger per crossing; re-arm after drop; failure backoff.
- Command parser: `auto`, token values, minimum, invalid input.
- Settings file atomic write with a temp directory.
- In-process write serialization: two writes queued together both land.

The settings path can be overridden with a test-only plugin option
`settingsPath` (or an equivalent environment variable). Every plugin instance
given the same path shares it, so the guarantee is unchanged; tests point it at
a temporary directory and never touch the user's real file.

Cross-process edits are last-writer-wins in v1: each write reads the current
file, applies only its field, and writes atomically; an in-process queue
serializes writes inside one server. Two separate server processes editing
different fields at the same instant can lose one update. That is rare and
acceptable for v1; no cross-process lock.

Server/live checks are a manual acceptance checklist, not an automated
server-spawn harness:

- Point `settingsPath` at a temporary directory; never use the real user file.
- Create two temporary sessions in the same project with different chat
  overrides; verify each effective threshold via the RPC `get` and via
  `/autocompact status`.
- Verify `/autocompact auto` falls back to project/global.
- Verify the model's `limit.context` is the real window (1,000,000 for
  `opencode-go/deepseek-v4.1-flash`) and is not capped.
- Verify `compaction.auto` remains false and manual `/autocompact compact`
  works.
- Verify settings-page RPC writes update the file and the `changed` event.
- Clean up temporary sessions and test settings files.

GUI checks:

- `npm run typecheck`, `npm test`, `npm run build:gui`.
- Open Settings and confirm the page renders global/project/chat rows.
- Open two chats with different overrides and confirm the pill shows different
  values and sources.
- Confirm the built-in ring still shows the real model window.
- Capture screenshots for the final report.

## Risks

- The GUI plugin API is experimental; pin to the installed OpenCode 2.3.x API.
- Building a GUI bundle adds a build step and Vite/Solid dependencies.
- Cross-location settings sync is file-mtime based, not push; each instance
  reads on demand.
- Project identity in worktrees depends on the canonical project directory.
- The Settings page needs a routed session for the project section; Home/no
  session editing is deferred.
- RPC events are live-only; missed events are recovered by refetching on mount.
- The built-in ring no longer reflects the autocompact threshold; the pill is
  the source of truth. This is deliberate to avoid the global model-limit lie.
- Session forks may inherit an override; acceptable but should be documented.

## What is left to the builder

- Exact Settings page control layout and copy.
- Exact JSON Schema syntax for the RPC contract.
- How to resolve/canonicalize the project directory in the GUI when the active
  session is a worktree.
- Whether to add a global "automatic compaction enabled" switch in a later
  version (not v1).
- Whether to add project-level settings to the TUI in a later version.
- Where to put the GUI build output in the package `files` list for publishing.

## Decisions from the builder check

These were the open implementation questions; they are settled here so the
builder does not have to guess:

1. **RPC addressing.** Every RPC call carries the canonical `directory` and,
   where relevant, `sessionID`. The handler uses the provided directory instead
   of assuming it reached the matching per-location plugin instance. The
   settings store is a process-global singleton, so all instances in one
   process share the cache and write queue.
2. **Freshness.** Open chats re-resolve on every step; the settings store checks
   the file mtime, throttled to once per second. Idle chats do not compact just
   because a value changed. Pills refetch on mount, session change, and the RPC
   `changed` event; a missed event is recovered on the next mount.
3. **Threshold changes.** Changing any threshold re-arms the session for the new
   line. If the context is already at or above it, compaction happens at the
   next step boundary. No idle compaction is triggered by a settings change;
   `/autocompact compact` is the explicit immediate request.
4. **Tests.** Pure unit tests plus a manual live checklist using a temporary
   `settingsPath`. No automated server-spawn harness in v1.
5. **Cross-process writes.** Last-writer-wins with read-modify-write and an
   in-process queue. No cross-process lock; documented as a v1 limitation.
6. **Migration.** Remove the old per-location storage key after the one-time
   check in every case, so it cannot resurrect a cleared project override.

## Success criteria

- A chat can set its own threshold without changing other chats.
- New chats use the project override, then the global default, then the plugin
  config fallback.
- The Settings page edits global and current-project values and shows the
  current chat's effective value/source.
- The composer pill shows the per-chat used/threshold and updates as the chat
  grows and as settings change.
- The built-in header ring continues to show the real model window.
- Compaction still fires once per crossing and does not loop.
- Unit tests, typecheck, GUI build, and the live checks above pass.
