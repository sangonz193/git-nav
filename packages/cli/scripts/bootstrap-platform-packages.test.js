import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapTag,
  packageExists,
  parseArguments,
  platformPackages,
  publishCommand,
} from "./bootstrap-platform-packages.ts";

const cliPackage = {
  binaryScope: "@git-nav",
  version: "0.0.5",
  optionalDependencies: {
    "@git-nav/linux-x64": "0.0.5",
    "@git-nav/win32-arm64": "0.0.5",
  },
  publishConfig: { access: "public" },
  repository: {
    type: "git",
    url: "git+https://github.com/sangonz193/git-nav.git",
  },
};

async function forwardedArguments(command) {
  const root = await mkdtemp(join(tmpdir(), "bootstrap-platform-packages-"));
  const cliRoot = join(root, "cli");

  try {
    await mkdir(cliRoot);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        workspaces: ["cli"],
        scripts: { bootstrap: "bun --filter=cli run bootstrap" },
      }),
    );
    await writeFile(
      join(cliRoot, "package.json"),
      JSON.stringify({
        name: "cli",
        scripts: { bootstrap: "bun arguments.ts" },
      }),
    );
    await writeFile(
      join(cliRoot, "arguments.ts"),
      "console.log(JSON.stringify(Bun.argv.slice(2)));\n",
    );

    const proc = Bun.spawn({
      cmd: [process.execPath, ...command],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    const output = `${stdout}\n${stderr}`;
    const arguments_ = output
      .split("\n")
      .findLast((line) => line.includes("["));
    if (!arguments_) throw new Error(output);
    return JSON.parse(arguments_.slice(arguments_.indexOf("[")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("platformPackages", () => {
  test("publishes placeholders with a non-release tag", () => {
    expect(bootstrapTag).toBe("bootstrap");
    expect(publishCommand()).toEqual([
      "npm",
      "publish",
      "--access",
      "public",
      "--tag",
      "bootstrap",
    ]);
  });

  test("creates unresolvable placeholder manifests", () => {
    expect(platformPackages(cliPackage)).toEqual([
      {
        name: "@git-nav/linux-x64",
        platform: "linux-x64",
        manifest: {
          name: "@git-nav/linux-x64",
          version: "0.0.5-bootstrap.0",
          os: ["linux"],
          cpu: ["x64"],
          publishConfig: { access: "public" },
          repository: cliPackage.repository,
        },
      },
      {
        name: "@git-nav/win32-arm64",
        platform: "win32-arm64",
        manifest: {
          name: "@git-nav/win32-arm64",
          version: "0.0.5-bootstrap.0",
          os: ["win32"],
          cpu: ["arm64"],
          publishConfig: { access: "public" },
          repository: cliPackage.repository,
        },
      },
    ]);
  });
});

describe("packageExists", () => {
  test("treats 404 responses as missing packages", async () => {
    expect(
      await packageExists(
        "@git-nav/linux-x64",
        async () => new Response(null, { status: 404 }),
      ),
    ).toBeFalse();
  });

  test("treats successful responses as existing packages", async () => {
    expect(
      await packageExists("@git-nav/darwin-arm64", async () => new Response()),
    ).toBeTrue();
  });
});

describe("parseArguments", () => {
  test("defaults to dry run", () => {
    expect(parseArguments([])).toBeFalse();
    expect(parseArguments(["--publish"])).toBeTrue();
  });

  test("rejects unsupported arguments", () => {
    expect(() => parseArguments(["--dry-run"])).toThrow();
    expect(() => parseArguments(["--publish", "--dry-run"])).toThrow();
  });

  test("rejects preview arguments forwarded through bun run", async () => {
    const arguments_ = await forwardedArguments([
      "run",
      "bootstrap",
      "--publish",
      "--dry-run",
    ]);

    expect(arguments_).toEqual(["--publish", "--dry-run"]);
    expect(() => parseArguments(arguments_)).toThrow();
  });

  test("forwards explicit publishing through bun run and direct invocation", async () => {
    expect(
      await forwardedArguments(["run", "bootstrap", "--", "--publish"]),
    ).toEqual(["--publish"]);
    expect(await forwardedArguments(["cli/arguments.ts", "--publish"])).toEqual(
      ["--publish"],
    );
  });
});
