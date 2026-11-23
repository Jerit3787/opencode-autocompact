import { defineConfig } from "vitest/config"

// Keep unit tests on Node and out of the GUI bundle config, which externalizes
// `@opencode/*` for the desktop app and pulls in the Solid jsdom environment.
export default defineConfig({
  test: {
    environment: "node",
  },
})
