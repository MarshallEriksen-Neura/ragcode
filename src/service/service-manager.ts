import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  detectServicePlatform,
  launchdLabelForRepo,
  resolveServiceIdentity,
  scheduledTaskNameForRepo,
  serviceNameForRepo,
  type ServicePlatform
} from "./service-identity.js";
import {
  launchdPlistPath,
  legacyWindowsWatcherScriptPath,
  renderWindowsWatcherScript,
  renderLaunchdPlist,
  renderSystemdUnit,
  schtasksCreateArgv,
  schtasksDeleteArgv,
  schtasksQueryArgv,
  systemdUserUnitPath,
  windowsWatcherScriptPath,
  type ServiceLaunchSpec
} from "./service-templates.js";

const execFileAsync = promisify(execFile);

// IO + OS-command dispatch layer for the per-repo watcher service. The pure identity/template
// modules decide *what* to write; this module decides *where* and runs the platform registrar
// (systemctl --user / launchctl / schtasks). Everything funnels through resolveServiceIdentity so
// install/uninstall/status agree on the same per-repo name.

export interface ServiceManagerOptions {
  /** Node/bun executable to launch the watcher with. Defaults to process.execPath. */
  execPath?: string;
  /** Resolved ragcode CLI entry. Defaults to the built dist CLI next to this module. */
  cliEntry?: string;
  /** Extra args appended to `watch <repoRoot>`, e.g. ["--poll"]. */
  extraArgs?: string[];
  /** Whether the launched watcher may bootstrap the index on start. Defaults to false. */
  indexOnStart?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface ServiceActionResult {
  ok: boolean;
  platform: ServicePlatform;
  serviceName: string;
  repoRoot: string;
  message: string;
  /** Path of the unit/plist written, when applicable. */
  unitPath?: string;
}

export interface ServiceStatusResult extends ServiceActionResult {
  installed: boolean;
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`Background watcher services are not supported on this platform (${platform}). Run \`ragcode watch <repo>\` manually or under your own process manager.`);
    this.name = "UnsupportedPlatformError";
  }
}

function resolveCliEntry(options: ServiceManagerOptions): string {
  if (options.cliEntry) return options.cliEntry;
  // This module lives at dist/src/service/service-manager.js once built; the CLI entry is one
  // directory over at dist/src/cli/index.js. fileURLToPath (not .pathname) is required for correct
  // Windows paths — .pathname yields "/D:/..." which path.resolve mangles.
  return fileURLToPath(new URL("../cli/index.js", import.meta.url));
}

function buildSpec(repoRoot: string, options: ServiceManagerOptions): ServiceLaunchSpec {
  return {
    execPath: options.execPath ?? process.execPath,
    cliEntry: resolveCliEntry(options),
    repoRoot: path.resolve(repoRoot),
    serviceName: serviceNameForRepo(repoRoot),
    indexOnStart: options.indexOnStart,
    extraArgs: options.extraArgs
  };
}

// `systemctl --user` and `launchctl` exit non-zero for benign "not loaded"/"already loaded" cases;
// callers decide whether a non-zero exit is fatal. We capture rather than throw so status can report.
async function run(file: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args);
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const code = typeof err.code === "number" ? err.code : 1;
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "", code };
  }
}

export async function installWatcherService(repoRoot: string, options: ServiceManagerOptions = {}): Promise<ServiceActionResult> {
  const platform = options.platform ?? os.platform();
  const kind = detectServicePlatform(platform);
  const identity = resolveServiceIdentity(repoRoot, platform);
  const spec = buildSpec(repoRoot, options);
  const home = options.home ?? os.homedir();

  switch (kind) {
    case "systemd": {
      const unitPath = systemdUserUnitPath(identity.serviceName, home);
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, renderSystemdUnit(spec), "utf8");
      await run("systemctl", ["--user", "daemon-reload"]);
      const enable = await run("systemctl", ["--user", "enable", "--now", `${identity.serviceName}.service`]);
      return {
        ok: enable.ok,
        platform: kind,
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        unitPath,
        message: enable.ok
          ? `Installed and started systemd user service ${identity.serviceName}. It will restart on login. (Enable lingering with \`loginctl enable-linger\` to keep it running while logged out.)`
          : `Wrote unit to ${unitPath} but \`systemctl --user enable --now\` failed: ${enable.stderr.trim()}`
      };
    }
    case "launchd": {
      const label = launchdLabelForRepo(repoRoot);
      const plistPath = launchdPlistPath(label, home);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, renderLaunchdPlist(spec, label), "utf8");
      // bootout any prior instance so re-install picks up a changed plist, then bootstrap fresh.
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      await run("launchctl", ["bootout", `gui/${uid}/${label}`]);
      const load = await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
      return {
        ok: load.ok,
        platform: kind,
        serviceName: label,
        repoRoot: identity.repoRoot,
        unitPath: plistPath,
        message: load.ok
          ? `Installed and loaded launchd agent ${label}. It will start on login and restart on crash.`
          : `Wrote plist to ${plistPath} but \`launchctl bootstrap\` failed: ${load.stderr.trim()}`
      };
    }
    case "schtasks": {
      const taskName = scheduledTaskNameForRepo(repoRoot);
      const scriptPath = windowsWatcherScriptPath(identity.repoRoot);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, renderWindowsWatcherScript(spec), "utf8");
      await fs.rm(legacyWindowsWatcherScriptPath(identity.repoRoot), { force: true }).catch(() => undefined);
      const create = await run("schtasks", schtasksCreateArgv(spec, taskName));
      // schtasks creates the task but doesn't run it immediately for onlogon; kick it once now.
      if (create.ok) await run("schtasks", ["/run", "/tn", taskName]);
      return {
        ok: create.ok,
        platform: kind,
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        unitPath: scriptPath,
        message: create.ok
          ? `Registered scheduled task ${taskName}. It runs on logon and relaunches every few minutes as a liveness backstop (the per-repo lock makes redundant launches no-ops).`
          : `\`schtasks /create\` failed: ${create.stderr.trim() || create.stdout.trim()}`
      };
    }
    default:
      throw new UnsupportedPlatformError(platform);
  }
}

export async function uninstallWatcherService(repoRoot: string, options: ServiceManagerOptions = {}): Promise<ServiceActionResult> {
  const platform = options.platform ?? os.platform();
  const kind = detectServicePlatform(platform);
  const identity = resolveServiceIdentity(repoRoot, platform);
  const home = options.home ?? os.homedir();

  switch (kind) {
    case "systemd": {
      const unitPath = systemdUserUnitPath(identity.serviceName, home);
      await run("systemctl", ["--user", "disable", "--now", `${identity.serviceName}.service`]);
      await fs.rm(unitPath, { force: true }).catch(() => undefined);
      await run("systemctl", ["--user", "daemon-reload"]);
      return {
        ok: true,
        platform: kind,
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        unitPath,
        message: `Removed systemd user service ${identity.serviceName}.`
      };
    }
    case "launchd": {
      const label = launchdLabelForRepo(repoRoot);
      const plistPath = launchdPlistPath(label, home);
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      await run("launchctl", ["bootout", `gui/${uid}/${label}`]);
      await fs.rm(plistPath, { force: true }).catch(() => undefined);
      return {
        ok: true,
        platform: kind,
        serviceName: label,
        repoRoot: identity.repoRoot,
        unitPath: plistPath,
        message: `Removed launchd agent ${label}.`
      };
    }
    case "schtasks": {
      const taskName = scheduledTaskNameForRepo(repoRoot);
      const del = await run("schtasks", schtasksDeleteArgv(taskName));
      const scriptPath = windowsWatcherScriptPath(identity.repoRoot);
      await fs.rm(scriptPath, { force: true }).catch(() => undefined);
      await fs.rm(legacyWindowsWatcherScriptPath(identity.repoRoot), { force: true }).catch(() => undefined);
      return {
        ok: del.ok,
        platform: kind,
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        unitPath: scriptPath,
        message: del.ok ? `Removed scheduled task ${taskName}.` : `\`schtasks /delete\` failed (it may not exist): ${del.stderr.trim() || del.stdout.trim()}`
      };
    }
    default:
      throw new UnsupportedPlatformError(platform);
  }
}

// Whether the OS registrar knows about the service. This is the registration check (is a unit
// installed?), distinct from runtime liveness (is the watcher process actually alive and
// heartbeating?), which readWatcherLiveness answers. doctor/status report both.
export async function watcherServiceStatus(repoRoot: string, options: ServiceManagerOptions = {}): Promise<ServiceStatusResult> {
  const platform = options.platform ?? os.platform();
  const kind = detectServicePlatform(platform);
  const identity = resolveServiceIdentity(repoRoot, platform);
  const home = options.home ?? os.homedir();

  switch (kind) {
    case "systemd": {
      const unitPath = systemdUserUnitPath(identity.serviceName, home);
      const exists = await fileExists(unitPath);
      const active = exists ? await run("systemctl", ["--user", "is-active", `${identity.serviceName}.service`]) : undefined;
      const state = active ? active.stdout.trim() || active.stderr.trim() : "not-installed";
      return {
        ok: true,
        installed: exists,
        platform: kind,
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        unitPath,
        message: exists ? `systemd user service ${identity.serviceName}: ${state}` : `No systemd user service installed for ${identity.repoRoot}.`
      };
    }
    case "launchd": {
      const label = launchdLabelForRepo(repoRoot);
      const plistPath = launchdPlistPath(label, home);
      const exists = await fileExists(plistPath);
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const print = exists ? await run("launchctl", ["print", `gui/${uid}/${label}`]) : undefined;
      return {
        ok: true,
        installed: exists,
        platform: kind,
        serviceName: label,
        repoRoot: identity.repoRoot,
        unitPath: plistPath,
        message: exists ? `launchd agent ${label}: ${print?.ok ? "loaded" : "installed but not loaded"}` : `No launchd agent installed for ${identity.repoRoot}.`
      };
    }
    case "schtasks": {
      const taskName = scheduledTaskNameForRepo(repoRoot);
      const query = await run("schtasks", schtasksQueryArgv(taskName));
      return {
        ok: true,
        installed: query.ok,
        platform: kind,
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        message: query.ok ? `Scheduled task ${taskName} is registered.` : `No scheduled task registered for ${identity.repoRoot}.`
      };
    }
    default:
      return {
        ok: false,
        installed: false,
        platform: "unsupported",
        serviceName: identity.serviceName,
        repoRoot: identity.repoRoot,
        message: new UnsupportedPlatformError(platform).message
      };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
