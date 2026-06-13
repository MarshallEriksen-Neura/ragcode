import { describe, expect, it } from "vitest";
import { packageManagerInvocation, runUpdate, PACKAGE_NAME } from "../src/cli/update.js";

// These exercise the decision logic without hitting the network or a package manager: `checkOnly`
// short-circuits before any install, and an explicit matching version is reported as up-to-date.
// Install dispatch (npm/pnpm/yarn argv) is covered indirectly — we avoid actually shelling out by
// only driving the no-install branches here.

describe("ragcode update", () => {
  it("reports up-to-date without installing when the pinned version equals the current one", async () => {
    // Resolve the real current version, then ask to "update" to that exact version: must no-op.
    const probe = await runUpdate({ checkOnly: true });
    const current = probe.currentVersion;
    expect(current).not.toBe("");

    const result = await runUpdate({ version: current });
    expect(result.installed).toBe(false);
    expect(result.upToDate).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(current);
  });

  it("check-only never installs and surfaces the current version", async () => {
    const result = await runUpdate({ checkOnly: true });
    expect(result.installed).toBe(false);
    expect(result.ok).toBe(true);
    expect(typeof result.currentVersion).toBe("string");
  });

  it("exposes the published package name used for global installs", () => {
    expect(PACKAGE_NAME).toBe("ragcode-context-engine");
  });

  it("runs package-manager shims through cmd on Windows", () => {
    const invocation = packageManagerInvocation("npm", ["view", PACKAGE_NAME, "version"], "win32");
    expect(invocation.file.toLowerCase()).toContain("cmd");
    expect(invocation.args).toEqual([
      "/d",
      "/c",
      `npm view ${PACKAGE_NAME} version`
    ]);
  });

  it("rejects unsafe shell characters before using the Windows command shim", () => {
    expect(() => packageManagerInvocation("npm", ["install", "ragcode-context-engine@latest&whoami"], "win32")).toThrow(
      /Unsafe package-manager argument/
    );
  });
});
