import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine, callTool, listToolDefinitions } from "../src/index.js";
import type { IndexStatus, RepoIndex, TopologyMap } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-agent-tools-"));
  await fs.mkdir(path.join(tempRoot, "src", "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "app", "api", "payments"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "services"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "app", "checkout", "CheckoutButton.tsx"),
    [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/payments', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Pay</button>;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "app", "api", "payments", "route.ts"),
    [
      "import { createPaymentIntent } from '../../../services/billing';",
      "",
      "export async function POST() {",
      "  return createPaymentIntent();",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.ts"),
    [
      "export function createPaymentIntent() {",
      "  return { clientSecret: 'agent-tools-secret' };",
      "}"
    ].join("\n")
  );
  await fs.writeFile(path.join(tempRoot, ".env"), "SECRET_TOKEN=do-not-index\n");
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("agent tool upgrades", () => {
  it("exposes index_status, refresh_index, and topology_map through MCP definitions", () => {
    const names = listToolDefinitions().map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(["index_status", "refresh_index", "topology_map"]));
  });

  it("reports freshness status and clears stale/pending state after refresh_index", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.writeFile(
      path.join(tempRoot, "src", "services", "billing.ts"),
      [
        "export function createPaymentIntent() {",
        "  return { clientSecret: 'changed-agent-tools-secret' };",
        "}"
      ].join("\n")
    );
    await fs.writeFile(path.join(tempRoot, "src", "services", "receipt.ts"), "export const receiptMarker = 'pending-receipt';\n");

    const staleStatus = await callTool(engine, "index_status", {}) as IndexStatus;
    expect(staleStatus.staleFileCount).toBe(1);
    expect(staleStatus.pendingFileCount).toBe(2);
    expect(staleStatus.freshness.staleFiles).toContain("src/services/billing.ts");
    expect(staleStatus.freshness.pendingFiles).toEqual(expect.arrayContaining(["src/services/billing.ts", "src/services/receipt.ts"]));
    expect(staleStatus.skippedFileCount).toBe(1);

    const refreshed = await callTool(engine, "refresh_index", {}) as RepoIndex;
    expect(refreshed.files.map((file) => file.path)).toContain("src/services/receipt.ts");

    const freshStatus = await callTool(engine, "index_status", {}) as IndexStatus;
    expect(freshStatus.staleFileCount).toBe(0);
    expect(freshStatus.pendingFileCount).toBe(0);
    expect(freshStatus.fileCount).toBe(refreshed.files.length);
  }, 15_000);

  it("returns owner-chain and topology evidence through topology_map", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const map = await callTool(engine, "topology_map", {
      query: "checkout payment billing",
      maxEdges: 8
    }) as TopologyMap;

    expect(map.owners.map((owner) => owner.filePath)).toEqual(expect.arrayContaining([
      "src/app/checkout/CheckoutButton.tsx",
      "src/services/billing.ts"
    ]));
    expect(map.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge: "calls_api",
        sourceFile: "src/app/checkout/CheckoutButton.tsx",
        targetFile: "src/app/api/payments/route.ts"
      }),
      expect.objectContaining({
        edge: "routes_to",
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts"
      })
    ]));
    expect(map.freshness.pendingFiles).toEqual([]);
  });
});
