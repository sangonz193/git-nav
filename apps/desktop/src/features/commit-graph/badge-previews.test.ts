import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test.each(["online", "offline"])(
  "refreshes badge previews and runs confirmed actions on desktop while %s",
  async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("./test-fixtures/badge-previews.tsx", import.meta.url),
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
