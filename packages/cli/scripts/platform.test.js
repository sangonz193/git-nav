import { describe, expect, test } from "bun:test";
import { binaryPathFor } from "../bin/platform.js";

describe("binaryPathFor", () => {
  test.each(["x64", "arm64"])("selects the Linux AppImage for %s", (arch) => {
    expect(binaryPathFor("linux", arch)).toBe("git-nav.AppImage");
  });

  test("keeps the macOS app bundle executable", () => {
    expect(binaryPathFor("darwin", "arm64")).toBe(
      "Git Nav.app/Contents/MacOS/git-nav",
    );
  });

  test.each(["x64", "arm64"])(
    "selects the Windows executable for %s",
    (arch) => {
      expect(binaryPathFor("win32", arch)).toBe("git-nav.exe");
    },
  );

  test("rejects unsupported platforms", () => {
    expect(binaryPathFor("freebsd", "x64")).toBeUndefined();
  });
});
