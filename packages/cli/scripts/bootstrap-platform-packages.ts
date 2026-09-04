import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "..");
const packagesRoot = resolve(cliRoot, "dist", "bootstrap-packages");
export const bootstrapTag = "bootstrap";

if (import.meta.main) {
  const publish = parseArguments(Bun.argv.slice(2));
  const cliPackage = await Bun.file(resolve(cliRoot, "package.json")).json();
  const packages = platformPackages(cliPackage);
  const missingPackages = [];

  for (const package_ of packages) {
    if (await packageExists(package_.name)) {
      console.log(`Skipping ${package_.name}: it already exists.`);
      continue;
    }

    missingPackages.push(package_);
  }

  for (const package_ of missingPackages) {
    const packageRoot = resolve(packagesRoot, package_.platform);
    await rm(packageRoot, { recursive: true, force: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      resolve(packageRoot, "package.json"),
      `${JSON.stringify(package_.manifest, null, 2)}\n`,
    );

    console.log(`\n${JSON.stringify(package_.manifest, null, 2)}`);
    console.log(
      `npm publish --access public --tag ${bootstrapTag} (from ${packageRoot})`,
    );

    if (publish) await publishPackage(packageRoot);
  }
}

export function platformPackages(cliPackage) {
  const scope = `${cliPackage.binaryScope}/`;

  return Object.keys(cliPackage.optionalDependencies).map((name) => {
    if (!name.startsWith(scope)) {
      throw new Error(`Unsupported platform package: ${name}`);
    }

    const platform = name.slice(scope.length);
    const [os, cpu] = platform.split("-");

    if (!os || !cpu || platform.split("-").length !== 2) {
      throw new Error(`Unsupported platform package: ${name}`);
    }

    return {
      name,
      platform,
      manifest: {
        name,
        version: `${cliPackage.version}-bootstrap.0`,
        os: [os],
        cpu: [cpu],
        publishConfig: cliPackage.publishConfig,
        repository: cliPackage.repository,
      },
    };
  });
}

export async function packageExists(name, request = fetch) {
  const response = await request(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  );

  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(
    `Could not check ${name}: registry returned ${response.status}.`,
  );
}

export function parseArguments(arguments_) {
  if (arguments_.length === 0) return false;

  if (arguments_.length === 1 && arguments_[0] === "--publish") return true;
  throw new Error(
    "Usage: bun scripts/bootstrap-platform-packages.ts [--publish]",
  );
}

async function publishPackage(cwd) {
  const proc = Bun.spawn(publishCommand(), {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

export function publishCommand() {
  return ["npm", "publish", "--access", "public", "--tag", bootstrapTag];
}
