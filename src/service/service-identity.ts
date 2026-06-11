import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

// One OS service per repo. The service name has to be stable for a given repo path (so install is
// idempotent and uninstall can find it), filesystem/identifier safe across systemd/launchd/schtasks,
// and collision-resistant between two repos whose basenames match (e.g. ~/work/api and ~/play/api).
// We combine a human-readable slug of the basename with a short hash of the absolute path.

export type ServicePlatform = "systemd" | "launchd" | "schtasks" | "unsupported";

export interface ServiceIdentity {
  /** Stable per-repo identifier, e.g. "ragcode-watch-api-3f9c1a2b". */
  serviceName: string;
  /** Absolute, normalized repo root the service watches. */
  repoRoot: string;
  platform: ServicePlatform;
}

export function detectServicePlatform(platform: NodeJS.Platform = os.platform()): ServicePlatform {
  switch (platform) {
    case "linux":
      return "systemd";
    case "darwin":
      return "launchd";
    case "win32":
      return "schtasks";
    default:
      return "unsupported";
  }
}

function slugifyBasename(repoRoot: string): string {
  const base = path.basename(path.resolve(repoRoot));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "repo";
}

function repoHash(repoRoot: string): string {
  // Normalize case on platforms with case-insensitive paths so the same repo always hashes the same.
  const normalized = process.platform === "win32" ? path.resolve(repoRoot).toLowerCase() : path.resolve(repoRoot);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

export function serviceNameForRepo(repoRoot: string): string {
  return `ragcode-watch-${slugifyBasename(repoRoot)}-${repoHash(repoRoot)}`;
}

// launchd labels are conventionally reverse-DNS; Task Scheduler tolerates backslashes as folders.
// systemd uses the bare name with a .service suffix. Each accessor keeps the platform convention
// local so the manager doesn't sprinkle platform conditionals around.
export function launchdLabelForRepo(repoRoot: string): string {
  return `com.ragcode.watch.${repoHash(repoRoot)}`;
}

export function scheduledTaskNameForRepo(repoRoot: string): string {
  return `RagCode\\${serviceNameForRepo(repoRoot)}`;
}

export function resolveServiceIdentity(repoRoot: string, platform: NodeJS.Platform = os.platform()): ServiceIdentity {
  return {
    serviceName: serviceNameForRepo(repoRoot),
    repoRoot: path.resolve(repoRoot),
    platform: detectServicePlatform(platform)
  };
}
