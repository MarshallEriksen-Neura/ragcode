import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("dotenv runtime config", () => {
  it("loads .env values without overwriting explicit env values", async () => {
    const root = await tempDir("ragcode-dotenv-");
    await fs.writeFile(
      path.join(root, ".env"),
      [
        "RAGCODE_GRAPH_STORE=sqlite",
        "RAGCODE_EMBEDDING_MODEL=qwen3-embedding:latest",
        "QUOTED_VALUE=\"hello world\""
      ].join("\n")
    );

    const env: NodeJS.ProcessEnv = {
      RAGCODE_GRAPH_STORE: "memory"
    };

    loadDotEnv(root, env);

    expect(env.RAGCODE_GRAPH_STORE).toBe("memory");
    expect(env.RAGCODE_EMBEDDING_MODEL).toBe("qwen3-embedding:latest");
    expect(env.QUOTED_VALUE).toBe("hello world");
  });
});

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
