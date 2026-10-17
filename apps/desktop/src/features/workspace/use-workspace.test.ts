import { describe, expect, test } from "bun:test"

describe("worktree selection", () => {
  test.each(["desktop", "browser"])("routes selections in %s", async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./test-fixtures/workspace-routing.tsx", import.meta.url)
          .pathname,
        mode,
      ],
      {
        cwd: new URL("../../../../", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    })
  })

  test.each(["workspace-startup", "workspace-project-errors"])(
    "runs %s",
    async (fixture) => {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL(`./test-fixtures/${fixture}.tsx`, import.meta.url).pathname,
        ],
        {
          cwd: new URL("../../../../", import.meta.url).pathname,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      })
    },
  )
})
