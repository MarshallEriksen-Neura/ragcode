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
// Task Scheduler (Windows) — repeat every few minutes as a liveness backstop. If the watcher died,
// the next interval relaunches it, and the per-repo lock guarantees a still-alive watcher makes the
// duplicate launch exit immediately. This is why the lock primitive (P0) is a hard prerequisite.
// ---------------------------------------------------------------------------

export interface SchtasksCreateOptions {
  /** Minutes between liveness relaunch attempts. Defaults to 5. */
  restartIntervalMinutes?: number;
}

export function schtasksCreateArgv(spec: ServiceLaunchSpec, taskName: string, options: SchtasksCreateOptions = {}): string[] {
  // schtasks /tr is limited to 261 chars on Windows. Keep it short and put the real hidden
  // watcher invocation in a repo-local wscript wrapper written by the service manager. wscript is
  // a GUI-subsystem host, so it avoids the visible console/Windows Terminal tab that direct
  // node.exe or powershell.exe task actions can create.
  const command = ["wscript.exe", "//B", "//Nologo", windowsWatcherScriptPath(spec.repoRoot)].map(windowsQuote).join(" ");
  const interval = options.restartIntervalMinutes ?? 5;
  return [
    "/create",
    "/tn", taskName,
    "/tr", command,
    "/sc", "minute",
    "/mo", String(interval),
    "/rl", "limited",
    "/f"
  ];
}

export function schtasksDeleteArgv(taskName: string): string[] {
  return ["/delete", "/tn", taskName, "/f"];
}

export function schtasksQueryArgv(taskName: string): string[] {
  return ["/query", "/tn", taskName];
}

export function windowsWatcherScriptPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ".ragcode", "watch-service.vbs");
}

export function legacyWindowsWatcherScriptPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ".ragcode", "watch-service.ps1");
}

export function renderWindowsWatcherScript(spec: ServiceLaunchSpec): string {
  const command = [spec.execPath, ...watchArgv(spec)].map(windowsCommandQuote).join(" ");
  return [
    "Option Explicit",
    "Dim shell",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.CurrentDirectory = ${vbscriptQuote(spec.repoRoot)}`,
    `shell.Run ${vbscriptQuote(command)}, 0, False`,
    ""
  ].join("\n");
}

// schtasks /tr is a single command string; wrap tokens with spaces in double quotes.
function windowsQuote(token: string): string {
  return /\s/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

function windowsCommandQuote(token: string): string {
  return /[\s"]/u.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

function vbscriptQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
