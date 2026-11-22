import { Rpc } from "@opencode/plugin/rpc"
import type { ThresholdSource } from "./settings"

export type SettingsPayload = {
  global: number
  project: number | null
  session: number | null
  effective: number
  source: ThresholdSource
  enabled: boolean
}

const payloadSchema = {
  type: "object",
  properties: {
    global: { type: "number" },
    project: { anyOf: [{ type: "number" }, { type: "null" }] },
    session: { anyOf: [{ type: "number" }, { type: "null" }] },
    effective: { type: "number" },
    source: { type: "string", enum: ["chat", "project", "global", "config"] },
    enabled: { type: "boolean" },
  },
  required: ["global", "project", "session", "effective", "source", "enabled"],
  additionalProperties: false,
} as const

const thresholdSchema = {
  anyOf: [{ type: "number" }, { type: "null" }],
} as const

const errors = {
  invalid_threshold: {
    type: "object",
    properties: { minimum: { type: "number" } },
    required: ["minimum"],
    additionalProperties: false,
  },
  write_failed: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
} as const

export const AutocompactRpc = Rpc.define({
  id: "autocompact",
  methods: {
    get: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: payloadSchema,
    },
    setGlobal: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          sessionID: { type: "string" },
          threshold: { type: "number" },
        },
        required: ["threshold"],
        additionalProperties: false,
      },
      output: payloadSchema,
      errors,
    },
    setProject: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          sessionID: { type: "string" },
          threshold: thresholdSchema,
        },
        required: ["directory", "threshold"],
        additionalProperties: false,
      },
      output: payloadSchema,
      errors,
    },
    setSession: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          sessionID: { type: "string" },
          threshold: thresholdSchema,
        },
        required: ["directory", "sessionID", "threshold"],
        additionalProperties: false,
      },
      output: payloadSchema,
      errors,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          directory: { type: "string" },
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
})

export function requestDirectory(input: { directory?: string }, fallback: string): string {
  const directory = typeof input.directory === "string" ? input.directory.trim() : ""
  return directory.length > 0 ? directory : fallback
}
