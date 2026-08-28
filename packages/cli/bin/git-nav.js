#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, normalize, relative, sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const binaryPaths = new Map([
  ["darwin-arm64", "Git Nav.app/Contents/MacOS/git-nav"],
  ["darwin-x64", "Git Nav.app/Contents/MacOS/git-nav"],
  ["linux-arm64", "git-nav"],
  ["linux-x64", "git-nav"],
  ["win32-arm64", "git-nav.exe"],
  ["win32-x64", "git-nav.exe"],
]);

const platformKey = `${process.platform}-${process.arch}`;
const binaryPath = binaryPaths.get(platformKey);

if (!binaryPath) {
  console.error(`Unsupported platform: ${platformKey}`);
  process.exit(1);
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { binaryScope } = require(join(packageRoot, "package.json"));
const platformPackage = `${binaryScope}/${platformKey}`;

function updateCommandFor(packagePath) {
  let resolvedPath;
  try {
    resolvedPath = realpathSync(packagePath);
  } catch {
    resolvedPath = normalize(packagePath);
  }

  const home = homedir();
  const originalPath = normalize(packagePath);
  const relativeToHome = relative(home, resolvedPath);
  const originalRelativeToHome = relative(home, originalPath);
  if (originalRelativeToHome.startsWith(`.npm${sep}_npx${sep}`)) {
    return undefined;
  }
  if (relativeToHome.startsWith(`.bun${sep}install${sep}cache${sep}`)) {
    return undefined;
  }

  const pathParts = resolvedPath.split(sep);
  if (pathParts.at(-2) === "node_modules" && pathParts.at(-1) === "git-nav") {
    const nodeModulesIndex = pathParts.length - 2;
    if (pathParts[nodeModulesIndex - 1] === "lib") {
      return "npm i -g git-nav@latest";
    }
    if (
      originalRelativeToHome.includes(
        `${sep}5${sep}node_modules${sep}git-nav`,
      ) ||
      pathParts.includes(".pnpm")
    ) {
      return "pnpm add -g git-nav@latest";
    }
    if (
      relativeToHome ===
      `.bun${sep}install${sep}global${sep}node_modules${sep}git-nav`
    ) {
      return "bun add -g git-nav@latest";
    }
    if (
      relativeToHome ===
      `.config${sep}yarn${sep}global${sep}node_modules${sep}git-nav`
    ) {
      return "yarn global add git-nav@latest";
    }
  }

  return "npm i -g git-nav@latest";
}

let executable;
try {
  executable = require.resolve(`${platformPackage}/${binaryPath}`);
} catch {
  console.error(
    `Missing executable for ${platformKey}. Install the optional dependency \"${platformPackage}\".`,
  );
  process.exit(1);
}

const updateCommand = updateCommandFor(packageRoot);
const child = spawn(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: updateCommand
    ? { ...process.env, GIT_NAV_UPDATE_COMMAND: updateCommand }
    : process.env,
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
