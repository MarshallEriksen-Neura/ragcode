import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);

// `ragcode update` upgrades the globally-installed CLI in place. We don't bundle an auto-updater;
// we shell out to the package manager that owns the global install. The published package name is
// `ragcode-context-engine` (see package.json), which is what npm/pnpm/yarn install globally.

export const PACKAGE_NAME = "ragcode-context-engine";

export interface UpdateOptions {
  /** Only report current vs latest; don't install. */
  checkOnly?: boolean;
  /** Override the package manager (npm/pnpm/yarn). Defaults to auto-detect. */
  packageManager?: string;
  /** Override the dist-tag/version to install. Defaults to "latest". */
  version?: string;
}

export interface UpdateResult {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  upToDate: boolean;
  installed: boolean;
  message: string;
}

function currentVersion(): string {
  // The package.json depth differs between source (src/cli/update.ts -> ../../package.json) and the
  // built layout (dist/src/cli/update.js -> ../../../package.json), so try both rather than guessing.
  const require = createRequire(import.meta.url);
  for (const candidate of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

// Auto-detect the package manager from the npm_config_user_agent the parent PM exposes, falling
// back to npm. This keeps a pnpm-global install from being "updated" by npm into a broken state.
function detectPackageManager(env: NodeJS.ProcessEnv = process.env): string {
  const agent = env.npm_config_user_agent ?? "";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("yarn")) return "yarn";
  return "npm";
}

async function fetchLatestVersion(): Promise<string | undefined> {
  // `npm view` works even under pnpm/yarn since npm is virtually always present; if it's not,
  // the catch downgrades us to a best-effort install without a pre-check.
  try {
    const { stdout } = await execFileAsync("npm", ["view", PACKAGE_NAME, "version"]);
    const version = stdout.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function installArgv(pm: string, spec: string): { file: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { file: "pnpm", args: ["add", "-g", spec] };
    case "yarn":
      return { file: "yarn", args: ["global", "add", spec] };
    default:
      return { file: "npm", args: ["install", "-g", spec] };
  }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const current = currentVersion();
  const pm = options.packageManager ?? detectPackageManager();
  const target = options.version ?? "latest";

  const latest = target === "latest" ? await fetchLatestVersion() : target;
  const upToDate = Boolean(latest && latest === current);

  if (options.checkOnly) {
    return {
      ok: true,
      currentVersion: current,
      latestVersion: latest,
      upToDate,
      installed: false,
      message: latest
        ? upToDate
          ? `RagCode is up to date (${current}).`
          : `Update available: ${current} → ${latest}. Run \`ragcode update\` to install.`
        : `Installed version ${current}. Could not reach the registry to check for updates.`
    };
  }

  if (upToDate) {
    return {
      ok: true,
      currentVersion: current,
      latestVersion: latest,
      upToDate: true,
      installed: false,
      message: `RagCode is already up to date (${current}).`
    };
  }

  const spec = `${PACKAGE_NAME}@${target}`;
  const { file, args } = installArgv(pm, spec);
  try {
    await execFileAsync(file, args);
    return {
      ok: true,
      currentVersion: current,
      latestVersion: latest,
      upToDate: false,
      installed: true,
      message: `Updated RagCode via ${pm} (${current} → ${latest ?? target}). Restart any running watchers and MCP clients to pick up the new version.`
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return {
      ok: false,
      currentVersion: current,
      latestVersion: latest,
      upToDate: false,
      installed: false,
      message: `Update via ${pm} failed: ${(err.stderr ?? err.message ?? "").trim()}. You can update manually with \`${file} ${args.join(" ")}\`.`
    };
  }
}
