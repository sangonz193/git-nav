import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import { argumentsForExecutable } from "../bin/arguments.js";

describe("argumentsForExecutable", () => {
  test("resolves a relative repository path", () => {
    expect(argumentsForExecutable(["."], "/workspace/project")).toEqual([
      "/workspace/project",
    ]);
  });

  test("preserves an absolute repository path", () => {
    expect(
      argumentsForExecutable(["/workspace/repository"], "/other-workspace"),
    ).toEqual(["/workspace/repository"]);
  });

  test("keeps serve arguments unchanged", () => {
    const arguments_ = ["serve", "--host", "0.0.0.0", "--port", "3000"];

    expect(argumentsForExecutable(arguments_, "/workspace/project")).toBe(
      arguments_,
    );
  });

  test("uses Windows paths when running on Windows", () => {
    expect(
      argumentsForExecutable(["."], "C:\\workspace\\project", win32.resolve),
    ).toEqual(["C:\\workspace\\project"]);
    expect(
      argumentsForExecutable(
        ["C:\\repository"],
        "C:\\workspace",
        win32.resolve,
      ),
    ).toEqual(["C:\\repository"]);
  });
});
