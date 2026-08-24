#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

let executable;
try {
  executable = require.resolve(`${platformPackage}/${binaryPath}`);
} catch {
  console.error(
    `Missing executable for ${platformKey}. Install the optional dependency \"${platformPackage}\".`,
  );
  process.exit(1);
}

const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });

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
