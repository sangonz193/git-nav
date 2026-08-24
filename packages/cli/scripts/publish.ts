import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "..");
const packagesRoot = resolve(cliRoot, "dist", "packages");
const packageDirs = await readdir(packagesRoot, { withFileTypes: true }).catch(
  () => {
    throw new Error(
      "No platform packages found. Run bun run build:package first.",
    );
  },
);

for (const entry of packageDirs) {
  if (!entry.isDirectory()) continue;
  await publish(resolve(packagesRoot, entry.name));
}

await publish(cliRoot);

async function publish(cwd: string) {
  const proc = Bun.spawn(["npm", "publish", "--access", "public"], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
