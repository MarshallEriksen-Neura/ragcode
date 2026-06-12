import os from "node:os";
import path from "node:path";

// Pure unit/plist/command generators — no IO. Each returns the exact text or argv that the manager
// writes/executes, so they can be snapshot-tested without touching the OS. Templates default to
// --no-index-on-start for boot safety; service install must not hide a long bootstrap in the
// launched OS service unless a lower-level caller explicitly opts into that behavior.

export interface ServiceLaunchSpec {
  /** Absolute path to the node/bun executable that runs the CLI. */
  execPath: string;
  /** Absolute path to the ragcode CLI entry (dist/src/cli/index.js) or a resolvable bin name. */
  cliEntry: string;
  repoRoot: string;
  serviceName: string;
  indexOnStart?: boolean;
  /** Extra args appended after `watch <repoRoot>`, e.g. ["--poll"]. */
  extraArgs?: string[];
}

export function watchArgv(spec: ServiceLaunchSpec): string[] {
  return [
    spec.cliEntry,
    "watch",
    spec.repoRoot,
    ...(spec.indexOnStart ? [] : ["--no-index-on-start"]),
    ...(spec.extraArgs ?? [])
  ];
}

// ---------------------------------------------------------------------------
// systemd (Linux) — user unit, no root. Restart=always survives crashes; the OS user session
// manager (re)starts it on login when enabled. WorkingDirectory pins relative config resolution.
// ---------------------------------------------------------------------------

export function renderSystemdUnit(spec: ServiceLaunchSpec): string {
  const execStart = [spec.execPath, ...watchArgv(spec)].map(systemdQuote).join(" ");
  return `[Unit]
Description=RagCode background watcher for ${spec.repoRoot}
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${spec.repoRoot}
Restart=always
RestartSec=5
# Avoid a crash-loop hammering CPU if the repo is broken; give up after repeated fast failures
# and let the user re-enable via 'ragcode service install'.
StartLimitIntervalSec=60
StartLimitBurst=5

[Install]
WantedBy=default.target
`;
}

// systemd ExecStart tokens are space-split; wrap tokens containing spaces in double quotes.
function systemdQuote(token: string): string {
  return /\s/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

export function systemdUserUnitPath(serviceName: string, home = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", `${serviceName}.service`);
}

// ---------------------------------------------------------------------------
// launchd (macOS) — LaunchAgent plist. KeepAlive restarts on crash; RunAtLoad starts on login.
// ---------------------------------------------------------------------------

export function renderLaunchdPlist(spec: ServiceLaunchSpec, label: string): string {
  const programArgs = [spec.execPath, ...watchArgv(spec)]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(spec.repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function launchdPlistPath(label: string, home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

// ---------------------------------------------------------------------------
// Task Scheduler (Windows) — onlogon trigger. schtasks has no native crash-restart, so we register
// the task to also run on a repeating schedule as a liveness backstop: if the watcher died, the
// next interval relaunches it, and the per-repo lock guarantees a still-alive watcher makes the
// duplicate launch exit immediately. This is why the lock primitive (P0) is a hard prerequisite.
// ---------------------------------------------------------------------------

export interface SchtasksCreateOptions {
  /** Minutes between liveness relaunch attempts. Defaults to 5. */
  restartIntervalMinutes?: number;
}

export function schtasksCreateArgv(spec: ServiceLaunchSpec, taskName: string, options: SchtasksCreateOptions = {}): string[] {
  // schtasks /tr takes a single string; quote each token so paths with spaces survive.
  const command = [spec.execPath, ...watchArgv(spec)].map(windowsQuote).join(" ");
  const interval = options.restartIntervalMinutes ?? 5;
  return [
    "/create",
    "/tn", taskName,
    "/tr", command,
    "/sc", "onlogon",
    "/rl", "limited",
    // Keep the task alive: repeat every N minutes indefinitely. The lock makes redundant launches no-ops.
    "/ri", String(interval),
    "/du", "9999:59",
    "/f"
  ];
}

export function schtasksDeleteArgv(taskName: string): string[] {
  return ["/delete", "/tn", taskName, "/f"];
}

export function schtasksQueryArgv(taskName: string): string[] {
  return ["/query", "/tn", taskName];
}

// schtasks /tr is a single command string; wrap tokens with spaces in double quotes.
function windowsQuote(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}
