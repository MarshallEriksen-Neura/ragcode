import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/index.js";
import { runInitConfig } from "../scripts/init-config.js";
import { buildMcpServerConfig } from "../scripts/setup-mcp.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("terminal-first onboarding", () => {
  it("writes offline-first init defaults without requiring credentials", async () => {
    const repoRoot = await tempDir("ragcode-init-defaults-");

    const result = await runInitConfig({ targetDir: repoRoot, defaults: true });
    const persisted = JSON.parse(await fs.readFile(path.join(repoRoot, ".ragcode", "config.json"), "utf8"));
    const effective = loadRuntimeConfig({ cwd: repoRoot, env: {} });

    expect(result.configPath).toBe(path.join(repoRoot, ".ragcode", "config.json"));
    expect(persisted).toMatchObject({
      graphStore: "sqlite",
      sqlitePath: path.join(".ragcode", "graph.sqlite"),
      semanticStore: "lancedb",
      lancedbUri: path.join(".ragcode", "lancedb"),
      embeddingProvider: "deterministic"
    });
    expect(effective.semantic.embeddingProvider).toBe("deterministic");
    expect(effective.embeddingApiKey).toBeUndefined();
  });

  it("generates MCP env from effective runtime config and redacts secrets by default", async () => {
    const repoRoot = await tempDir("ragcode-setup-mcp-");
    await fs.mkdir(path.join(repoRoot, ".ragcode"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".ragcode", "config.json"), JSON.stringify({
      graphStore: "sqlite",
      sqlitePath: ".ragcode/custom.sqlite",
      semanticStore: "lancedb",
      lancedbUri: ".ragcode/vectors",
      embeddingProvider: "openai-compatible",
      embeddingBaseUrl: "https://embed.example/v1",
      embeddingModel: "custom-embed",
      embeddingApiKey: "persisted-secret"
    }, null, 2));

    const redacted = buildMcpServerConfig({ cwd: repoRoot, env: {} });
    const withSecrets = buildMcpServerConfig({ cwd: repoRoot, env: {}, includeSecrets: true });

    expect(redacted.cwd).toBe(repoRoot);
    expect(redacted.env).toMatchObject({
      RAGCODE_SQLITE_PATH: path.join(repoRoot, ".ragcode", "custom.sqlite"),
      RAGCODE_LANCEDB_URI: path.join(repoRoot, ".ragcode", "vectors"),
      RAGCODE_EMBEDDING_PROVIDER: "openai-compatible",
      RAGCODE_EMBEDDING_BASE_URL: "https://embed.example/v1",
      RAGCODE_EMBEDDING_MODEL: "custom-embed",
      RAGCODE_EMBEDDING_API_KEY: "<redacted>"
    });
    expect(withSecrets.env?.RAGCODE_EMBEDDING_API_KEY).toBe("persisted-secret");
  });
});

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
