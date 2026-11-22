# opencode-autocompact

An OpenCode plugin that compacts a session when its context reaches an absolute
token threshold — 500,000 tokens by default. The threshold can differ per chat,
per project, and globally.

OpenCode's built-in compaction is window-relative (`compaction.buffer`), so the
absolute point where it fires changes with the model. This plugin watches the
actual conversation size reported after each model step and requests compaction
when that size crosses a fixed line.

## Behavior

- Listens for `session.step.ended` events and sums the step's usage:
  `input + output + reasoning + cache.read + cache.write`.
- Resolves each chat's threshold with this precedence:
  **chat → project → global → plugin config**.
- Leaves `model.limit.context` at the provider's real value, so OpenCode's
  context ring and Context panel show the real model window. Autocompact status
  comes from `/autocompact` and the composer pill.
- At the effective threshold, requests `session.compact`. OpenCode runs it at
  the next step boundary, before the next model call.
- Triggers once per crossing. After compaction it re-arms only when the context
  drops below the threshold, so a compaction that cannot shrink the conversation
  (for example, mostly fixed instructions) cannot loop.
- A failed compaction is retried after a backoff (5 minutes by default).
- Reacts to compactions started by anything else — including OpenCode's built-in
  auto-compaction — and does not request a duplicate.

Subagent sessions are handled the same way as top-level sessions.

## Install

The global config already loads it, and turns off OpenCode's own window-based
auto-compaction so it cannot fire first:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "compaction": {
    "auto": false,
    "background": false,
  },
  "plugins": [
    {
      "package": "/Users/danishhakim/Documents/Default Project/opencode-autocompact",
      "options": {
        "threshold": 500000,
      },
    },
  ],
}
```

For any other machine, point `package` at this directory (or publish the
package) and reload OpenCode. The server entry is TypeScript; the desktop GUI
entry is the committed `dist/gui-experimental.cjs`.

Leave `compaction.buffer` at its default positive reserve. Setting it to `0`
makes the compaction request measure its input at the whole window, which
collapses the summary's output budget to the 1,024-token floor and fails the
summary with "reached the output token limit".

## Command

The plugin registers `/autocompact`:

| Command | Behavior |
| --- | --- |
| `/autocompact` | Show the effective threshold and its source, current context, and whether compaction is armed, pending, paused, or disabled. |
| `/autocompact 500k` | Set this chat's threshold. Also accepts `500000`, `1M`, or a bare `300` (meaning 300,000). Minimum 100,000. |
| `/autocompact auto` | Clear this chat's override and fall back to the project, global, or plugin config value. |
| `/autocompact compact` | Request compaction now; it runs at the next step boundary. |

A chat override is stored in `session.metadata.autocompact.threshold`, so it
travels with that chat. Status reports the source (`chat`, `project`, `global`,
or `config`) and the global/project fallbacks when they apply.

The command posts its result as a session notice. Notices are delivered on the
next turn, so running `/autocompact` does not spend a model call by itself.

To disable automatic triggering entirely, set `enabled: false` in the plugin
options. The tool and `/autocompact compact` still work.

## Settings

**Settings → Autocompact** edits values that apply across chats:

- **Global default** — used when a project has no override.
- **Projects** — one row for every project in `~/.config/opencode/autocompact.json`,
  with Save and **Use global** to clear the override. **Add project** adds a
  directory at the current global value, then the row can be edited.
- Chat thresholds are not edited on this page. Use `/autocompact` in the chat,
  or reset from the composer pill.

Project keys are canonical absolute directories. A worktree session or a
session opened in a project subfolder resolves to its project root's override,
not to the worktree path. **Add project** accepts `~`, requires an absolute
path, and resolves symlinks, so the key matches the project the server uses.

The settings file is read with an mtime/size cache checked at most once per
second. Writes are atomic (`temp` + rename) and serialized in-process. If the
file cannot be read or parsed, the plugin copies it to
`~/.config/opencode/autocompact.json.bak`, shows a warning in Settings, and
refuses to save until the file is fixed or removed; a save cannot silently
replace the other project entries with a partial file.

## Composer pill

A pill above the composer shows the chat's current context against its
effective threshold, for example `253k / 600k`. It turns warning-colored at 80%
and danger-colored at 90%. Its rows show the source, the global value, the
project value, and a **Reset chat override** action when the chat has one. The
pill refetches after `/autocompact` and after settings changes.

The built-in header ring remains the model-window indicator; the pill is the
autocompact indicator.

## Options

| Option         | Default  | Meaning                                                              |
| -------------- | -------- | -------------------------------------------------------------------- |
| `threshold`    | `500000` | Fallback threshold when no chat, project, or global value applies. Accepts `500000`, `"500k"`, or `"1m"`. |
| `enabled`      | `true`   | Set to `false` to keep the tool available but disable automatic compaction. |
| `retryAfterMs` | `300000` | Backoff after a failed compaction before another attempt.            |
| `settingsPath` | unset    | Test-only override for `~/.config/opencode/autocompact.json`. Do not set it for normal use. |

Example: fall back to 300k and retry failures after one minute.

```jsonc
{
  "plugins": [
    {
      "package": "/Users/danishhakim/Documents/Default Project/opencode-autocompact",
      "options": {
        "threshold": "300k",
        "retryAfterMs": 60000,
      },
    },
  ],
}
```

## Migration

Older versions stored one threshold per location in plugin storage. On the
first start after upgrading, if that value exists and the project has no entry
in `autocompact.json`, the plugin writes it as that project's override. The old
storage key is removed after that check, so clearing the project override later
cannot resurrect the old value. If `autocompact.json` is unreadable, migration
is skipped and the old key is kept for a later start rather than risking the
file.

Cross-process writes are last-writer-wins with a read-modify-write and an
in-process queue; there is no cross-process lock. Session forks inherit the
chat override.

## Tool

The plugin also registers an `autocompact` tool:

- `action: "status"` — reports the effective threshold, source, current context,
  and whether auto-compaction is armed, pending, paused, or disabled.
- `action: "compact"` — requests compaction immediately.
- `action: "set"` with `tokens` — sets this chat's threshold.
- `action: "auto"` — clears this chat's override.

Ask the agent "how full is this session?" or "compact this session" to use it.

## Keep recent context

Compaction is lossy. Set `compaction.keep.tokens` in OpenCode's config to keep
more exact recent conversation beside the summary:

```jsonc
{
  "compaction": {
    "auto": false,
    "keep": { "tokens": 30000 },
  },
}
```

Turn `compaction.auto` off when you want this plugin to be the only automatic
trigger. OpenCode's own window-based compaction otherwise fires first, at a
point that depends on the model's context window, and ignores the absolute
threshold. Manual compaction still works with `auto` disabled.

Keep thresholds below the model's context window. With built-in compaction
disabled there is no fallback if a request grows past the window before the
threshold is reached.

## Built-in alternative

If your model's context window is larger than the threshold and you only care
about free space, OpenCode can do this without a plugin:

```jsonc
{
  "compaction": {
    "buffer": 500000,
  },
}
```

`buffer` is the room kept free, so with a 1M-token window that compacts at
500k. A `buffer` at least as large as the model's window is ignored, which is
why this plugin uses the conversation size directly.

## Development

```sh
npm install
npm run check
```

`npm run check` runs the typecheck, the unit tests, and the GUI build. Commit
`dist/gui-experimental.cjs`; the desktop app loads that file directly.

`opencode reload` picks up changes to `src/index.ts`. Changes to modules it
imports, such as `src/engine.ts`, need `opencode service restart` because the
server keeps the loaded module.
