import { createRequire } from "node:module";

export const PACKAGE_NAME = "ragcode-context-engine";

export function getPackageVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
    } catch {
      // Source and built layouts have different depths; try the next candidate.
    }
  }
  return "unknown";
}
