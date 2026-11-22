import { ComposerPill, Plugin, SettingsPage } from "@opencode/plugin/gui"
import { readSessionOverride } from "./settings"
import { autocompactPillView } from "./gui/pill"
import { AutocompactSettingsPage } from "./gui/settings-page"
import {
  clearSession,
  loadSettings,
  settingsKey,
  settingsState,
  subscribeSettings,
} from "./gui/state"

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

    ctx.add(ComposerPill, {
      id: "autocompact",
      order: 0,
      show: (input) => {
        const directory = input.session.directory
        const key = settingsKey(directory, input.session.id)
        const payload = settingsState[key]

        if (!payload) {
          void loadSettings(ctx, { directory, sessionID: input.session.id })
          return undefined
        }

        let override: number | null = null
        try {
          const info = input.session.server.data.session.get(input.session.id)
          override = readSessionOverride(info?.metadata)
        } catch {
          return undefined
        }

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

    return () => unsubscribe()
  },
})
