import { describe, expect, it } from "vitest"
import { requestDirectory } from "./rpc"

describe("requestDirectory", () => {
  it("uses the request directory instead of the receiving instance", () => {
    expect(requestDirectory({ directory: "/project/a" }, "/project/b")).toBe("/project/a")
    expect(requestDirectory({}, "/project/b")).toBe("/project/b")
    expect(requestDirectory({ directory: "  " }, "/project/b")).toBe("/project/b")
  })
})
