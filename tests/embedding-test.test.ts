import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEmbeddingTest } from "../src/index.js";
import { applyConfigureUpdates } from "../src/cli/configure.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("embedding test service", () => {
  it("tests the deterministic provider offline with dimensions and latency", async () => {
    const repoRoot = await tempDir("ragcode-embed-det-");

    const result = await runEmbeddingTest({ cwd: repoRoot, env: {} });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("deterministic");
    expect(result.dimensions).toBe(64);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.failure).toBeUndefined();
  });

  it("classifies a missing API key without sending a request", async () => {
    const repoRoot = await tempDir("ragcode-embed-nokey-");

    const result = await runEmbeddingTest({
      cwd: repoRoot,
      env: { RAGCODE_EMBEDDING_PROVIDER: "openai-compatible" },
      fetchImpl: () => {
        throw new Error("must not be called");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("missing_key");
  });

  it("classifies auth failures and never exposes the API key", async () => {
    const repoRoot = await tempDir("ragcode-embed-auth-");

    const result = await runEmbeddingTest({
      cwd: repoRoot,
      env: {
        RAGCODE_EMBEDDING_PROVIDER: "openai-compatible",
        RAGCODE_EMBEDDING_API_KEY: "secret-key-value"
      },
      fetchImpl: (async () => jsonResponse(401, { error: { message: "Incorrect API key provided" } })) as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("auth_failure");
    expect(JSON.stringify(result)).not.toContain("secret-key-value");
  });

  it("classifies dimension mismatches between provider output and configured dimensions", async () => {
    const repoRoot = await tempDir("ragcode-embed-dims-");

    const result = await runEmbeddingTest({
      cwd: repoRoot,
      env: {
        RAGCODE_EMBEDDING_PROVIDER: "openai-compatible",
        RAGCODE_EMBEDDING_API_KEY: "k",
        RAGCODE_EMBEDDING_DIMENSIONS: "128"
      },
      fetchImpl: (async () => jsonResponse(200, { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })) as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("dimensions_mismatch");
    expect(result.dimensions).toBe(3);
    expect(result.requestedDimensions).toBe(128);
  });

  it("classifies unreachable endpoints as network failures", async () => {
    const repoRoot = await tempDir("ragcode-embed-net-");

    const result = await runEmbeddingTest({
      cwd: repoRoot,
      env: {
        RAGCODE_EMBEDDING_PROVIDER: "openai-compatible",
        RAGCODE_EMBEDDING_API_KEY: "k"
      },
      fetchImpl: (async () => {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("network_failure");
  });
});

describe("configure command core", () => {
  it("merges updates into .ragcode/config.json and returns redacted effective config", async () => {
    const repoRoot = await tempDir("ragcode-configure-");

    const result = await applyConfigureUpdates({
      repoRoot,
      env: {},
      updates: {
        embeddingProvider: "openai",
        embeddingBaseUrl: "https://embed.example/v1",
        embeddingModel: "custom-embed",
        embeddingApiKey: "persisted-secret",
        embeddingDimensions: 256
      }
    });
    const persisted = JSON.parse(await fs.readFile(path.join(repoRoot, ".ragcode", "config.json"), "utf8"));

    // "openai" alias normalizes on write; the secret persists to disk but only "set" comes back.
    expect(persisted.embeddingProvider).toBe("openai-compatible");
    expect(persisted.embeddingApiKey).toBe("persisted-secret");
    expect(result.config.embeddingProvider).toBe("openai-compatible");
    expect(result.config.embeddingBaseUrl).toBe("https://embed.example/v1");
    expect(result.config.embeddingDimensions).toBe(256);
    expect(result.config.embeddingApiKey).toBe("set");
    expect(JSON.stringify(result.config)).not.toContain("persisted-secret");
  });

  it("preserves existing config fields that are not updated", async () => {
    const repoRoot = await tempDir("ragcode-configure-merge-");
    await fs.mkdir(path.join(repoRoot, ".ragcode"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".ragcode", "config.json"), JSON.stringify({
      graphStore: "sqlite",
      sqlitePath: ".ragcode/custom.sqlite",
      embeddingProvider: "deterministic"
    }));

    const result = await applyConfigureUpdates({
      repoRoot,
      env: {},
      updates: { embeddingDimensions: 32 },
      testEmbedding: true
    });

    expect(result.config.sqlitePath).toBe(path.join(repoRoot, ".ragcode", "custom.sqlite"));
    expect(result.config.embeddingProvider).toBe("deterministic");
    expect(result.config.embeddingDimensions).toBe(32);
    expect(result.embeddingTest?.ok).toBe(true);
    expect(result.embeddingTest?.dimensions).toBe(32);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
