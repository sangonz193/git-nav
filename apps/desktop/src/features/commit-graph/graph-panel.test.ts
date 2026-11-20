import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const renameModes = ["rename-status-first", "rename-commits-first"]

const modes = [
  "online",
  "offline",
  "browser",
  "refresh",
  "filtered",
  "linked",
  "stash",
]

test.each([...modes, ...renameModes])(
  "renders graph refreshes and badge previews in %s mode",
  async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("./test-fixtures/graph-panel.tsx", import.meta.url),
        ),
        mode,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
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
