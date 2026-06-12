import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectServicePlatform,
  launchdLabelForRepo,
  resolveServiceIdentity,
  scheduledTaskNameForRepo,
  serviceNameForRepo
} from "../src/service/service-identity.js";
import {
  launchdPlistPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  schtasksCreateArgv,
  systemdUserUnitPath,
  watchArgv,
  type ServiceLaunchSpec
} from "../src/service/service-templates.js";
import {
  installWatcherService,
  uninstallWatcherService,
  watcherServiceStatus
} from "../src/service/service-manager.js";
import { normalizeServiceInstallOptions } from "../src/cli/service-install-options.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

function spec(repoRoot: string): ServiceLaunchSpec {
  return {
    execPath: "/usr/bin/node",
    cliEntry: "/opt/ragcode/dist/src/cli/index.js",
    repoRoot,
    serviceName: serviceNameForRepo(repoRoot)
  };
}

describe("service identity", () => {
  it("maps platforms to registrars", () => {
    expect(detectServicePlatform("linux")).toBe("systemd");
    expect(detectServicePlatform("darwin")).toBe("launchd");
    expect(detectServicePlatform("win32")).toBe("schtasks");
    expect(detectServicePlatform("aix")).toBe("unsupported");
  });

  it("produces a stable, repo-specific service name", () => {
    const a = serviceNameForRepo("/home/me/work/api");
    const b = serviceNameForRepo("/home/me/work/api");
    expect(a).toBe(b);
    expect(a).toMatch(/^ragcode-watch-api-[0-9a-f]{8}$/);
  });

  it("disambiguates same-basename repos by path hash", () => {
    expect(serviceNameForRepo("/home/me/work/api")).not.toBe(serviceNameForRepo("/home/me/play/api"));
  });

  it("derives launchd and schtasks identifiers", () => {
    expect(launchdLabelForRepo("/r/api")).toMatch(/^com\.ragcode\.watch\.[0-9a-f]{8}$/);
    expect(scheduledTaskNameForRepo("/r/api")).toMatch(/^RagCode\\ragcode-watch-api-[0-9a-f]{8}$/);
  });

  it("resolves a full identity for the host platform", () => {
    const identity = resolveServiceIdentity("/r/api", "linux");
    expect(identity.platform).toBe("systemd");
    expect(identity.repoRoot).toBe(path.resolve("/r/api"));
  });
});

describe("service templates", () => {
  it("launches the watcher with --no-index-on-start so boot doesn't block on a reindex", () => {
    const argv = watchArgv(spec("/r/api"));
    expect(argv).toEqual(["/opt/ragcode/dist/src/cli/index.js", "watch", "/r/api", "--no-index-on-start"]);
  });

  it("appends extra args after the repo root", () => {
    const argv = watchArgv({ ...spec("/r/api"), extraArgs: ["--poll"] });
    expect(argv).toEqual(["/opt/ragcode/dist/src/cli/index.js", "watch", "/r/api", "--no-index-on-start", "--poll"]);
  });

  it("keeps service-start indexing disabled even when bootstrap tuning args are present", () => {
    const argv = watchArgv({ ...spec("/r/api"), extraArgs: ["--max-batch-files", "250"] });
    expect(argv).toEqual(["/opt/ragcode/dist/src/cli/index.js", "watch", "/r/api", "--no-index-on-start", "--max-batch-files", "250"]);
  });

  it("normalizes service install to no synchronous index unless --index-now is explicit", () => {
    expect(normalizeServiceInstallOptions({})).toEqual({ indexNow: false, extraArgs: undefined });
    expect(normalizeServiceInstallOptions({ indexNow: true, poll: true, bootstrapBatchSize: 250, maxAnalysisMemoryMb: 1024 })).toEqual({
      indexNow: true,
      bootstrapBatchSize: 250,
      maxAnalysisMemoryMb: 1024,
      extraArgs: ["--poll", "--max-batch-files", "250", "--max-analysis-memory-mb", "1024"]
    });
  });

  it("renders a restart-on-crash systemd user unit", () => {
    const unit = renderSystemdUnit(spec("/r/api"));
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/ragcode/dist/src/cli/index.js watch /r/api --no-index-on-start");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes systemd ExecStart tokens that contain spaces", () => {
    const unit = renderSystemdUnit({ ...spec("/r/my api"), repoRoot: "/r/my api" });
    expect(unit).toContain('"/r/my api"');
  });

  it("renders a KeepAlive launchd plist with escaped args", () => {
    const plist = renderLaunchdPlist(spec("/r/api"), "com.ragcode.watch.deadbeef");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<string>com.ragcode.watch.deadbeef</string>");
    expect(plist).toContain("<string>--no-index-on-start</string>");
  });

  it("builds an onlogon schtasks create argv with a liveness repeat interval", () => {
    const argv = schtasksCreateArgv(spec("/r/api"), "RagCode\\task", { restartIntervalMinutes: 7 });
    expect(argv).toContain("/create");
    expect(argv).toContain("onlogon");
    expect(argv[argv.indexOf("/ri") + 1]).toBe("7");
    expect(argv).toContain("/f");
  });

  it("places unit/plist files under user config dirs", () => {
    expect(systemdUserUnitPath("svc", "/home/me")).toBe(path.join("/home/me", ".config", "systemd", "user", "svc.service"));
    expect(launchdPlistPath("com.x", "/Users/me")).toBe(path.join("/Users/me", "Library", "LaunchAgents", "com.x.plist"));
  });
});

describe("service manager IO (systemd, sandboxed home)", () => {
  it("writes a unit file on install and removes it on uninstall", async () => {
    if (os.platform() === "win32") return; // systemctl isn't present; we still verify file IO via the linux branch
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-svc-home-"));
    tempRoots.push(home);
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-svc-repo-"));
    tempRoots.push(repoRoot);

    // Force the systemd branch regardless of host OS so the unit-file IO is exercised everywhere.
    // systemctl calls will fail in CI (no user bus); install reports ok:false but still writes the unit.
    const installed = await installWatcherService(repoRoot, { platform: "linux", home });
    const unitPath = systemdUserUnitPath(serviceNameForRepo(repoRoot), home);
    const unitContents = await fs.readFile(unitPath, "utf8");
    expect(unitContents).toContain("ExecStart=");
    expect(installed.unitPath).toBe(unitPath);

    const status = await watcherServiceStatus(repoRoot, { platform: "linux", home });
    expect(status.installed).toBe(true);

    await uninstallWatcherService(repoRoot, { platform: "linux", home });
    await expect(fs.access(unitPath)).rejects.toThrow();
  });
});
