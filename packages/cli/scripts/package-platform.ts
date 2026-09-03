import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(cliRoot, "..", "..");
const desktopRoot = resolve(repositoryRoot, "apps", "desktop");
const tauriRoot = resolve(desktopRoot, "src-tauri");
const platformKey = `${process.platform}-${process.arch}`;
const cliPackage = await Bun.file(resolve(cliRoot, "package.json")).json();
const source = artifactFor(platformKey);
const packageRoot = resolve(cliRoot, "dist", "packages", platformKey);

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

  if (platform.startsWith("linux-")) {
    return resolve(
      tauriRoot,
      "target",
      "release",
      "bundle",
      "appimage",
      `Git Nav_${cliPackage.version}_${appImageArchitecture(platform)}.AppImage`,
    );
  }

  return resolve(tauriRoot, "target", "release", executableName(platform));
}

function artifactName(platform: string) {
  if (platform.startsWith("darwin-")) return "Git Nav.app";
  if (platform.startsWith("linux-")) return "git-nav.AppImage";
  return executableName(platform);
}

function appImageArchitecture(platform: string) {
  if (platform === "linux-x64") return "amd64";
  if (platform === "linux-arm64") return "aarch64";
  throw new Error(`Unsupported AppImage platform: ${platform}`);
}

function executableName(platform: string) {
  return platform.startsWith("win32-") ? "git-nav.exe" : "git-nav";
}
