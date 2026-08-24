import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(cliRoot, "..", "..");
const desktopRoot = resolve(repositoryRoot, "apps", "desktop");
const tauriRoot = resolve(desktopRoot, "src-tauri");
const platformKey = `${process.platform}-${process.arch}`;
const source = artifactFor(platformKey);
const packageRoot = resolve(cliRoot, "dist", "packages", platformKey);
const cliPackage = await Bun.file(resolve(cliRoot, "package.json")).json();

await stat(source);
await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
await cp(source, resolve(packageRoot, artifactName(platformKey)), {
  recursive: true,
});

await writeFile(
  resolve(packageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: `${cliPackage.binaryScope}/${platformKey}`,
      version: cliPackage.version,
      os: [process.platform],
      cpu: [process.arch],
      files: [artifactName(platformKey)],
      publishConfig: cliPackage.publishConfig,
      repository: cliPackage.repository,
    },
    null,
    2,
  )}\n`,
);

function artifactFor(platform: string) {
  if (platform.startsWith("darwin-")) {
    return resolve(
      tauriRoot,
      "target",
      "release",
      "bundle",
      "macos",
      "Git Nav.app",
    );
  }

  return resolve(tauriRoot, "target", "release", executableName(platform));
}

function artifactName(platform: string) {
  return platform.startsWith("darwin-")
    ? "Git Nav.app"
    : executableName(platform);
}

function executableName(platform: string) {
  return platform.startsWith("win32-") ? "git-nav.exe" : "git-nav";
}
