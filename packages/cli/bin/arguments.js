import { resolve } from "node:path";

export function argumentsForExecutable(
  arguments_,
  cwd = process.cwd(),
  resolvePath = resolve,
) {
  if (arguments_[0] === "serve" || arguments_.length === 0) {
    return arguments_;
  }

  return [resolvePath(cwd, arguments_[0]), ...arguments_.slice(1)];
}
