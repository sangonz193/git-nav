// Runs the API server next to the dev server so the browser build works from another device.
import { resolve } from "node:path"

const desktopRoot = resolve(import.meta.dir, "..")

const children = [
  Bun.spawn(
    ["cargo", "run", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--", "serve", "--foreground", "--no-token"],
    { cwd: desktopRoot, stdio: ["inherit", "inherit", "inherit"] }
  ),
  Bun.spawn(["bunx", "--bun", "vite"], {
    cwd: desktopRoot,
    stdio: ["inherit", "inherit", "inherit"],
  }),
]

let stopping = false
function stop(code: number) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    child.kill()
  }
  process.exit(code)
}

process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
process.on("exit", () => children.forEach((child) => child.kill()))

// Neither process is expected to exit on its own, so treat the first exit as a failure to report.
await Promise.race(children.map((child) => child.exited))
stop(1)
