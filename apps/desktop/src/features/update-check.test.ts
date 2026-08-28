import { describe, expect, test } from "bun:test"

import { compareVersions } from "./version-comparison"

describe("compareVersions", () => {
  test("orders release versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1)
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("1.2.2", "1.2.3")).toBe(-1)
  })

  test("supports a leading v and missing patch versions", () => {
    expect(compareVersions("v2.0", "2.0.0")).toBe(0)
  })
})
