import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const tauriRoot = resolve(root, "apps/desktop/src-tauri");

const increments = ["major", "minor", "patch"] as const;
type Increment = (typeof increments)[number];

const request = Bun.argv[2];
if (!request) {
  throw new Error("Usage: bun bump <major|minor|patch|x.y.z>");
}

if (await isDirty()) {
  throw new Error(
    "The working tree has uncommitted changes. Commit or stash them so the release commit only carries the version bump.",
  );
}

const rootManifest = resolve(root, "package.json");
const current = parse((await Bun.file(rootManifest).json()).version);
const next = isIncrement(request) ? increment(current, request) : parse(request);

if (compare(next, current) <= 0) {
  throw new Error(
    `${format(next)} does not come after the current version ${format(current)}.`,
  );
}

const from = format(current);
const to = format(next);

await edit(rootManifest, (text) => replaceFirst(text, /"version": "[^"]+"/, `"version": "${to}"`));
await edit(resolve(root, "apps/desktop/package.json"), (text) =>
  replaceFirst(text, /"version": "[^"]+"/, `"version": "${to}"`),
);
await edit(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), (text) =>
  replaceFirst(text, /"version": "[^"]+"/, `"version": "${to}"`),
);
await edit(resolve(tauriRoot, "Cargo.toml"), (text) =>
  replaceFirst(text, /^version = "[^"]+"/m, `version = "${to}"`),
);
await edit(resolve(root, "packages/cli/package.json"), (text) => {
  const bumped = replaceFirst(text, /"version": "[^"]+"/, `"version": "${to}"`);
  // Each platform package is published at the release version, so a stale pin here breaks installs.
  return bumped.replace(/("@git-nav\/[^"]+": ")[^"]+(")/g, `$1${to}$2`);
});

await run(["bun", "install"], root);
await run(["cargo", "update", "--offline", "-p", "git-nav"], tauriRoot);

await run(["git", "add", "--", ...changedPaths()], root);
await run(["git", "commit", "-m", `chore(release): bump version to ${to}`], root);

console.log(`\nbumped ${from} -> ${to}`);
console.log("once the commit is on main, publish it with:");
console.log(`  git tag v${to} && git push origin v${to}`);

function changedPaths() {
  return [
    "package.json",
    "bun.lock",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/Cargo.lock",
    "apps/desktop/src-tauri/tauri.conf.json",
    "packages/cli/package.json",
  ];
}

function isIncrement(value: string): value is Increment {
  return (increments as readonly string[]).includes(value);
}

function parse(value: unknown) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  if (!match) {
    throw new Error(`${value} is not a x.y.z version.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

type Version = ReturnType<typeof parse>;

function format(version: Version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function increment(version: Version, kind: Increment) {
  if (kind === "major") return { major: version.major + 1, minor: 0, patch: 0 };
  if (kind === "minor") return { major: version.major, minor: version.minor + 1, patch: 0 };
  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

function compare(left: Version, right: Version) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function replaceFirst(text: string, pattern: RegExp, replacement: string) {
  if (!pattern.test(text)) {
    throw new Error(`Could not find ${pattern} to replace.`);
  }
  return text.replace(pattern, replacement);
}

async function edit(path: string, update: (text: string) => string) {
  const file = Bun.file(path);
  await Bun.write(file, update(await file.text()));
}

async function isDirty() {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim().length > 0;
}

async function run(command: string[], cwd: string) {
  const proc = Bun.spawn(command, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed with code ${code}.`);
  }
}
