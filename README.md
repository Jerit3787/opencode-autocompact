# opencode-autocompact

An OpenCode server plugin that compacts a session when its context reaches an
absolute token threshold — 500,000 tokens by default.

OpenCode's built-in compaction is window-relative (`compaction.buffer`), so the
absolute point where it fires changes with the model. This plugin watches the
actual conversation size reported after each model step and requests compaction
when that size crosses a fixed line.

## Behavior

- Listens for `session.step.ended` events and sums the step's usage:
  `input + output + reasoning + cache.read + cache.write`.
- Leaves `model.limit.context` at the provider's real value, so OpenCode's
  context ring and Context panel show the real model window. Autocompact status
  comes from `/autocompact` and the composer pill.
- At `threshold` tokens, requests `session.compact`. OpenCode runs it at the
  next step boundary, before the next model call.
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
package) and reload OpenCode. No build step is needed; the plugin entry is
TypeScript.

Leave `compaction.buffer` at its default positive reserve. Setting it to `0`
makes the compaction request measure its input at the whole window, which
collapses the summary's output budget to the 1,024-token floor and fails the
summary with "reached the output token limit".

## Command

The plugin registers `/autocompact`:

| Command | Behavior |
| --- | --- |
| `/autocompact` | Show the threshold, current context, and whether compaction is armed, pending, paused, or disabled. |
| `/autocompact 500k` | Set the threshold. Also accepts `500000`, `1M`, or a bare `300` (meaning 300,000). Minimum 100,000. |
| `/autocompact auto` | Remove the saved override and use the plugin's configured `threshold`, with automatic compaction still on. |
| `/autocompact compact` | Request compaction now; it runs at the next step boundary. |

To disable automatic triggering entirely, set `enabled: false` in the plugin
options (the equivalent of Claude Code's separate auto-compact setting). The
tool and `/autocompact compact` still work.

Threshold changes take effect immediately and are saved in plugin storage, which
takes precedence over the `threshold` option. `/autocompact auto` clears the
saved value and restores the configured one.

The command posts its result as a session notice. Notices are delivered on the
next turn, so running `/autocompact` does not spend a model call by itself.

The header context ring and Context panel now measure against the threshold:
with a 500k threshold, 300k tokens reads as 60%, not 30% of 1M. `/autocompact
700k` changes the ring to a 700k ceiling; `/autocompact auto` returns to the
configured 500k. Setting `enabled: false` removes the cap and restores the
provider's real window.

Status and threshold changes show the active model's context window and warn
when the threshold is at or above it. For example, 500k is fine on a 1M model,
but a 200k model would hit its limit before the threshold fires.

## Options

| Option         | Default  | Meaning                                                              |
| -------------- | -------- | -------------------------------------------------------------------- |
| `threshold`    | `500000` | Conversation size that triggers compaction. Accepts `500000`, `"500k"`, or `"1m"`. |
| `enabled`      | `true`   | Set to `false` to keep the tool available but disable automatic compaction. |
| `retryAfterMs` | `300000` | Backoff after a failed compaction before another attempt.            |

Example: compact at 300k and retry failures after one minute.

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

## Tool

The plugin also registers an `autocompact` tool:

- `action: "status"` — reports current context tokens, threshold, and whether
  auto-compaction is armed, pending, paused, or disabled.
- `action: "compact"` — requests compaction immediately.

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

Keep `threshold` below the model's context window. With built-in compaction
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

## Compared with Claude Code

Claude Code treats the setting as an **auto-compact window**: how full the
context window may get before it summarizes. With no window set, a model with a
native 1M window compacts at about 967,000 tokens. `/autocompact 500k` lowers
that to 500,000. The command accepts 100K to 1M, lets a bare 100-1000 mean
thousands, caps the value at the model's real context window, saves it for the
current model, and `/autocompact auto` returns to the model-tuned default.
Claude Code also stops auto-compacting after a few attempts when summaries
cannot keep up, instead of looping.

This plugin uses one absolute number for every model. That is deliberate:
OpenCode's built-in compaction is window-relative, so its firing point changes
with the model. Set `compaction.auto` to `false` so the built-in does not
preempt the absolute threshold.

## Development

```sh
npm install
npm test
npm run typecheck
```

`opencode reload` picks up changes to `src/index.ts`. Changes to modules it
imports, such as `src/engine.ts`, need `opencode service restart` because the
server keeps the loaded module.
