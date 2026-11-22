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
